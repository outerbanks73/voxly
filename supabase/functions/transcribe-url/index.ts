// Voxly - Transcribe URL Edge Function
// Transcribes URLs via Supadata.ai (YouTube, TikTok, Instagram, X, Facebook, any public URL).
// Flow: Validate JWT → check quota → call Supadata → handle async if needed → normalize → increment usage → return

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const SUPADATA_API_KEY = Deno.env.get('SUPADATA_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Validate JWT
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const body = await req.json()

    // Handle polling for async jobs
    if (body.poll && body.jobId) {
      return await handlePollJob(body.jobId)
    }

    // New transcription request
    const { url } = body
    if (!url) {
      return new Response(JSON.stringify({ error: 'Missing url' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Check quota
    const quotaOk = await checkQuota(supabase, user.id)
    if (!quotaOk) {
      return new Response(JSON.stringify({ error: 'Monthly quota exceeded. Upgrade to Pro for unlimited.' }), {
        status: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Call Supadata transcript API
    const supadataUrl = `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(url)}&text=false&mode=auto`
    const supadataResponse = await fetch(supadataUrl, {
      headers: {
        'x-api-key': SUPADATA_API_KEY
      }
    })

    if (!supadataResponse.ok) {
      const errText = await supadataResponse.text()
      return new Response(JSON.stringify({ error: `Supadata error: ${errText}` }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const supadataResult = await supadataResponse.json()

    // Check if this is an async job (long videos >20 min)
    if (supadataResult.jobId) {
      return new Response(JSON.stringify({
        jobId: supadataResult.jobId,
        status: 'processing'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Immediate result — normalize and return
    const result = normalizeSupadataResult(supadataResult)

    // Increment usage
    await incrementUsage(supabase, user.id)

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})

async function handlePollJob(jobId: string) {
  const pollUrl = `https://api.supadata.ai/v1/transcript/${jobId}`
  const response = await fetch(pollUrl, {
    headers: { 'x-api-key': SUPADATA_API_KEY }
  })

  if (!response.ok) {
    return new Response(JSON.stringify({ status: 'error', error: 'Poll failed' }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  const data = await response.json()

  if (data.status === 'completed' && data.content) {
    const result = normalizeSupadataResult(data)
    return new Response(JSON.stringify({ ...result, status: 'completed' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } else if (data.status === 'error') {
    return new Response(JSON.stringify({ status: 'error', error: data.error || 'Transcription failed' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  // Still processing
  return new Response(JSON.stringify({ status: 'processing' }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

function normalizeSupadataResult(data: any) {
  const content = data.content || []

  // Map Supadata segments: offset (ms) → start (s), offset+duration → end (s)
  const segments = content.map((item: any) => ({
    timestamp: formatTime(item.offset / 1000),
    text: item.text,
    start: item.offset / 1000,
    end: (item.offset + item.duration) / 1000
  }))

  const fullText = content.map((item: any) => item.text).join(' ')

  return {
    full_text: fullText,
    segments,
    speakers: [],
    language: data.lang || null,
    title: data.title || null,
    duration: content.length > 0
      ? (content[content.length - 1].offset + content[content.length - 1].duration) / 1000
      : null,
    diarization_status: 'skipped'
  }
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0')
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${mins}:${secs}`
}

async function checkQuota(sb: any, userId: string): Promise<boolean> {
  const { data: profile } = await sb.from('profiles').select('is_premium').eq('id', userId).single()
  if (profile?.is_premium) return true

  const period = new Date().toISOString().substring(0, 7)
  const { data: usage } = await sb.from('usage').select('count').eq('user_id', userId).eq('period', period).single()

  return !usage || usage.count < 15
}

async function incrementUsage(sb: any, userId: string) {
  const period = new Date().toISOString().substring(0, 7)
  const { data: existing } = await sb.from('usage').select('id, count').eq('user_id', userId).eq('period', period).single()

  if (existing) {
    await sb.from('usage').update({ count: existing.count + 1 }).eq('id', existing.id)
  } else {
    await sb.from('usage').insert({ user_id: userId, period, count: 1 })
  }
}

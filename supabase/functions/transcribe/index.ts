// Voxly - Transcribe Edge Function
// Transcribes audio files via Deepgram Nova-2 pre-recorded API.
// Flow: Validate JWT → check quota → read file from Storage → POST to Deepgram → normalize → increment usage → return

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const DEEPGRAM_API_KEY = Deno.env.get('DEEPGRAM_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  // CORS preflight
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

    // Create authenticated Supabase client for the user
    const supabaseUser = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Parse request
    const { storagePath } = await req.json()
    if (!storagePath) {
      return new Response(JSON.stringify({ error: 'Missing storagePath' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Check quota (free tier: 15/month)
    const quotaOk = await checkQuota(supabaseUser, user.id)
    if (!quotaOk) {
      return new Response(JSON.stringify({ error: 'Monthly quota exceeded. Upgrade to Pro for unlimited.' }), {
        status: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Generate signed URL for the uploaded file
    const { data: signedUrlData, error: urlError } = await supabaseUser.storage
      .from('audio-files')
      .createSignedUrl(storagePath, 3600) // 1 hour expiry

    if (urlError || !signedUrlData?.signedUrl) {
      return new Response(JSON.stringify({ error: 'Failed to access uploaded file' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Send to Deepgram pre-recorded API
    const deepgramResponse = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&diarize=true&utterances=true', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: signedUrlData.signedUrl })
    })

    if (!deepgramResponse.ok) {
      const errText = await deepgramResponse.text()
      return new Response(JSON.stringify({ error: `Deepgram error: ${errText}` }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const dgResult = await deepgramResponse.json()

    // Normalize Deepgram response to Voxly format
    const result = normalizeDeepgramResult(dgResult)

    // Increment usage
    await incrementUsage(supabaseUser, user.id)

    // Clean up uploaded file (best effort)
    supabaseUser.storage.from('audio-files').remove([storagePath]).catch(() => {})

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

function normalizeDeepgramResult(dg: any) {
  const channel = dg.results?.channels?.[0]
  const alternatives = channel?.alternatives?.[0]

  // Use utterances for natural segment boundaries
  const utterances = dg.results?.utterances || []
  const segments = utterances.map((u: any) => ({
    timestamp: formatTime(u.start),
    text: u.transcript,
    start: u.start,
    end: u.end,
    speaker: u.speaker !== undefined ? `Speaker ${u.speaker}` : undefined
  }))

  // Extract unique speakers
  const speakerSet = new Set(utterances.map((u: any) => u.speaker).filter((s: any) => s !== undefined))
  const speakers = Array.from(speakerSet).map((s: any) => `Speaker ${s}`)

  return {
    full_text: alternatives?.transcript || '',
    segments,
    speakers,
    language: dg.results?.channels?.[0]?.detected_language || null,
    duration: dg.metadata?.duration || null,
    diarization_status: speakers.length > 0 ? 'success' : 'skipped'
  }
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0')
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${mins}:${secs}`
}

async function checkQuota(sb: any, userId: string): Promise<boolean> {
  // Check if user is premium
  const { data: profile } = await sb.from('profiles').select('is_premium').eq('id', userId).single()
  if (profile?.is_premium) return true

  // Check monthly usage
  const period = new Date().toISOString().substring(0, 7) // YYYY-MM
  const { data: usage } = await sb.from('usage').select('count').eq('user_id', userId).eq('period', period).single()

  return !usage || usage.count < 15
}

async function incrementUsage(sb: any, userId: string) {
  const period = new Date().toISOString().substring(0, 7) // YYYY-MM

  // Upsert: increment existing or create new
  const { data: existing } = await sb.from('usage').select('id, count').eq('user_id', userId).eq('period', period).single()

  if (existing) {
    await sb.from('usage').update({ count: existing.count + 1 }).eq('id', existing.id)
  } else {
    await sb.from('usage').insert({ user_id: userId, period, count: 1 })
  }
}

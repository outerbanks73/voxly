// Voxly - Transcribe URL Edge Function
// Transcribes URLs via a cost-optimized cascade:
//   YouTube: YouTube captions (free) → Supadata → Deepgram Nova-2 → error
//   Social (TikTok, Instagram, X, Facebook): Supadata → Deepgram Nova-2 → error
//   Direct media: Supadata → Deepgram Nova-2 → error
// Flow: Validate JWT → check quota → cascade → normalize → increment usage → return

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const SUPADATA_API_KEY = Deno.env.get('SUPADATA_API_KEY')!
const DEEPGRAM_API_KEY = Deno.env.get('DEEPGRAM_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// --- URL Classification ---

type UrlPlatform = 'youtube' | 'social' | 'direct'

function classifyUrl(url: string): UrlPlatform {
  if (/youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/live\/|youtube-nocookie\.com/.test(url)) {
    return 'youtube'
  }
  if (/tiktok\.com|instagram\.com|twitter\.com|x\.com|facebook\.com|fb\.watch/.test(url)) {
    return 'social'
  }
  return 'direct'
}

function extractYouTubeVideoId(url: string): string | null {
  // youtube.com/watch?v=ID
  let match = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/)
  if (match) return match[1]
  // youtu.be/ID
  match = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/)
  if (match) return match[1]
  // youtube.com/shorts/ID or /live/ID
  match = url.match(/youtube\.com\/(?:shorts|live)\/([a-zA-Z0-9_-]{11})/)
  if (match) return match[1]
  return null
}

// --- YouTube Captions (Free) ---

async function tryYouTubeCaptions(videoId: string): Promise<any | null> {
  try {
    // Fetch the YouTube watch page to extract player response
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`
    const pageResponse = await fetch(watchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    })

    if (!pageResponse.ok) return null

    const html = await pageResponse.text()

    // Extract ytInitialPlayerResponse JSON from the page
    const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.*?});/)
    if (!playerMatch) return null

    const playerResponse = JSON.parse(playerMatch[1])
    const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    if (!captionTracks || captionTracks.length === 0) return null

    // Prefer manual captions over auto-generated (kind: 'asr')
    const manualTrack = captionTracks.find((t: any) => t.kind !== 'asr')
    const track = manualTrack || captionTracks[0]

    // Fetch caption data in JSON3 format
    const captionUrl = track.baseUrl + '&fmt=json3'
    const captionResponse = await fetch(captionUrl)
    if (!captionResponse.ok) return null

    const captionData = await captionResponse.json()
    const events = captionData.events || []

    // Filter to actual caption segments (have segs with text)
    const segments = events
      .filter((e: any) => e.segs && e.segs.some((s: any) => s.utf8 && s.utf8.trim()))
      .map((e: any) => {
        const text = e.segs.map((s: any) => s.utf8 || '').join('').trim()
        const startSec = (e.tStartMs || 0) / 1000
        const durationSec = (e.dDurationMs || 0) / 1000
        return {
          timestamp: formatTime(startSec),
          text,
          start: startSec,
          end: startSec + durationSec
        }
      })
      .filter((s: any) => s.text.length > 0)

    if (segments.length === 0) return null

    const fullText = segments.map((s: any) => s.text).join(' ')
    const lastSeg = segments[segments.length - 1]

    // Extract video title from player response
    const title = playerResponse?.videoDetails?.title || null
    const language = track.languageCode || null

    return {
      full_text: fullText,
      segments,
      speakers: [],
      language,
      title,
      duration: lastSeg.end,
      diarization_status: 'skipped'
    }
  } catch (_e) {
    return null
  }
}

// --- Supadata (Existing Logic, Refactored) ---

async function trySupadata(url: string): Promise<any | null> {
  try {
    const supadataUrl = `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(url)}&text=false&mode=auto`
    const supadataResponse = await fetch(supadataUrl, {
      headers: { 'x-api-key': SUPADATA_API_KEY }
    })

    if (!supadataResponse.ok) return null

    const supadataResult = await supadataResponse.json()

    // Async job — return the jobId wrapper so the main handler can forward it
    if (supadataResult.jobId) {
      return { _async: true, jobId: supadataResult.jobId }
    }

    return normalizeSupadataResult(supadataResult)
  } catch (_e) {
    return null
  }
}

// --- Deepgram URL Transcription (Fallback for Direct Media) ---

async function tryDeepgramUrl(url: string): Promise<any | null> {
  try {
    const dgResponse = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&utterances=true',
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${DEEPGRAM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url })
      }
    )

    if (!dgResponse.ok) return null

    const dgResult = await dgResponse.json()
    return normalizeDeepgramResult(dgResult)
  } catch (_e) {
    return null
  }
}

// --- Normalization ---

function normalizeSupadataResult(data: any) {
  const content = data.content || []

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

function normalizeDeepgramResult(dg: any) {
  const alternatives = dg.results?.channels?.[0]?.alternatives?.[0]
  const utterances = dg.results?.utterances || []

  const segments = utterances.map((u: any) => ({
    timestamp: formatTime(u.start),
    text: u.transcript,
    start: u.start,
    end: u.end,
    speaker: u.speaker !== undefined ? `Speaker ${u.speaker}` : undefined
  }))

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

// --- Quota ---

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

// --- Polling (unchanged) ---

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

  return new Response(JSON.stringify({ status: 'processing' }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

// --- Main Handler ---

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

    // --- Cascade ---
    const platform = classifyUrl(url)
    let result: any = null
    const steps: string[] = []

    // Step 1: YouTube captions (free, fast)
    if (platform === 'youtube') {
      const videoId = extractYouTubeVideoId(url)
      if (videoId) {
        result = await tryYouTubeCaptions(videoId)
        steps.push(result ? 'youtube_captions:success' : 'youtube_captions:failed')
      }
    }

    // Step 2: Supadata (works for all platforms)
    if (!result) {
      result = await trySupadata(url)
      steps.push(result ? 'supadata:success' : 'supadata:failed')

      // If Supadata returned an async job, forward immediately
      if (result?._async) {
        return new Response(JSON.stringify({
          jobId: result.jobId,
          status: 'processing',
          metadata: { method: 'supadata', cascade_steps: steps }
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }

    // Step 3: Deepgram fallback (all platforms)
    if (!result) {
      result = await tryDeepgramUrl(url)
      steps.push(result ? 'deepgram:success' : 'deepgram:failed')
    }

    // All cascade steps failed
    if (!result) {
      return new Response(JSON.stringify({
        error: 'Transcription failed — all methods exhausted',
        cascade_steps: steps
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Add cascade metadata to result
    const method = steps.find(s => s.includes(':success'))?.split(':')[0]
    result.metadata = { method, cascade_steps: steps }

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

// Voxly API - Supabase Edge Function
// Provides CRUD API for transcripts authenticated via API keys.
// Developers can download transcripts and submit new ones programmatically.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-api-key, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return jsonResponse({ error: 'Missing x-api-key header' }, 401)
    }

    // Hash the provided key
    const encoder = new TextEncoder()
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(apiKey))
    const keyHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0')).join('')

    // Create Supabase admin client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const sb = createClient(supabaseUrl, serviceRoleKey)

    // Look up the API key
    const { data: keyRecord, error: keyError } = await sb
      .from('api_keys')
      .select('id, user_id')
      .eq('key_hash', keyHash)
      .is('revoked_at', null)
      .single()

    if (keyError || !keyRecord) {
      return jsonResponse({ error: 'Invalid API key' }, 401)
    }

    const userId = keyRecord.user_id

    // Update last_used timestamp (fire and forget)
    sb.from('api_keys').update({ last_used: new Date().toISOString() }).eq('id', keyRecord.id).then()

    // Route the request
    const url = new URL(req.url)
    const path = url.pathname.replace(/^\/api-transcripts\/?/, '')
    const transcriptId = path || null

    switch (req.method) {
      case 'GET':
        if (transcriptId) {
          return await getTranscript(sb, userId, transcriptId)
        }
        return await listTranscripts(sb, userId, url.searchParams)

      case 'POST':
        return await createTranscript(sb, userId, req)

      case 'PUT':
        if (!transcriptId) return jsonResponse({ error: 'Transcript ID required' }, 400)
        return await updateTranscript(sb, userId, transcriptId, req)

      case 'DELETE':
        if (!transcriptId) return jsonResponse({ error: 'Transcript ID required' }, 400)
        return await deleteTranscript(sb, userId, transcriptId)

      default:
        return jsonResponse({ error: 'Method not allowed' }, 405)
    }
  } catch (e) {
    console.error('API error:', e)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
})

// List transcripts with pagination and optional search
async function listTranscripts(sb: any, userId: string, params: URLSearchParams) {
  const page = parseInt(params.get('page') || '1')
  const pageSize = Math.min(parseInt(params.get('page_size') || '20'), 100)
  const search = params.get('search') || ''
  const offset = (page - 1) * pageSize

  let query = sb
    .from('transcripts')
    .select('id, title, source, source_type, duration_display, word_count, language, created_at, is_public', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1)

  if (search) {
    query = query.textSearch('full_text', search, { type: 'websearch' })
  }

  const { data, count, error } = await query
  if (error) return jsonResponse({ error: error.message }, 500)

  return jsonResponse({
    data: data || [],
    total: count || 0,
    page,
    page_size: pageSize
  })
}

// Get a single transcript
async function getTranscript(sb: any, userId: string, transcriptId: string) {
  const { data, error } = await sb
    .from('transcripts')
    .select('*')
    .eq('id', transcriptId)
    .eq('user_id', userId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return jsonResponse({ error: 'Transcript not found' }, 404)
    return jsonResponse({ error: error.message }, 500)
  }

  return jsonResponse(data)
}

// Create a new transcript
async function createTranscript(sb: any, userId: string, req: Request) {
  const body = await req.json()

  const row = {
    user_id: userId,
    title: body.title || 'Untitled',
    source: body.source || null,
    source_type: body.source_type || null,
    uploader: body.uploader || null,
    duration_seconds: body.duration_seconds || null,
    duration_display: body.duration_display || null,
    language: body.language || 'en',
    model: body.model || null,
    word_count: body.full_text ? body.full_text.split(/\s+/).length : 0,
    extraction_method: body.extraction_method || 'api',
    full_text: body.full_text || '',
    segments: body.segments || [],
    speakers: body.speakers || [],
    diarization_status: body.diarization_status || null,
    summary: body.summary || null,
    processed_at: body.processed_at || new Date().toISOString()
  }

  const { data, error } = await sb.from('transcripts').insert(row).select('id, created_at').single()

  if (error) return jsonResponse({ error: error.message }, 500)

  return jsonResponse({ id: data.id, created_at: data.created_at }, 201)
}

// Update a transcript
async function updateTranscript(sb: any, userId: string, transcriptId: string, req: Request) {
  const body = await req.json()

  // Only allow updating certain fields
  const allowedFields = [
    'title', 'source', 'source_type', 'uploader', 'language',
    'full_text', 'segments', 'speakers', 'summary'
  ]
  const updates: Record<string, any> = {}
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field]
    }
  }

  if (updates.full_text) {
    updates.word_count = updates.full_text.split(/\s+/).length
  }

  const { error } = await sb
    .from('transcripts')
    .update(updates)
    .eq('id', transcriptId)
    .eq('user_id', userId)

  if (error) return jsonResponse({ error: error.message }, 500)

  return jsonResponse({ updated: true })
}

// Delete a transcript
async function deleteTranscript(sb: any, userId: string, transcriptId: string) {
  const { error } = await sb
    .from('transcripts')
    .delete()
    .eq('id', transcriptId)
    .eq('user_id', userId)

  if (error) return jsonResponse({ error: error.message }, 500)

  return jsonResponse({ deleted: true })
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

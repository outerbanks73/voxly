// Voxly - Realtime Token Edge Function
// Creates a temporary, scoped Deepgram API key for WebSocket streaming.
// Flow: Validate JWT → check quota → create temp key → return

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const DEEPGRAM_API_KEY = Deno.env.get('DEEPGRAM_API_KEY')!
const DEEPGRAM_PROJECT_ID = Deno.env.get('DEEPGRAM_PROJECT_ID')!
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

    // Check quota
    const quotaOk = await checkQuota(supabase, user.id)
    if (!quotaOk) {
      return new Response(JSON.stringify({ error: 'Monthly quota exceeded. Upgrade to Pro for unlimited.' }), {
        status: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Create temporary Deepgram API key (short TTL)
    const response = await fetch(`https://api.deepgram.com/v1/projects/${DEEPGRAM_PROJECT_ID}/keys`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        comment: `Voxly realtime - ${user.id}`,
        scopes: ['usage:write', 'listen'],
        time_to_live_in_seconds: 300, // 5 minute TTL
        tags: ['voxly', 'realtime']
      })
    })

    if (!response.ok) {
      const errText = await response.text()
      return new Response(JSON.stringify({ error: `Deepgram key creation failed: ${errText}` }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const keyData = await response.json()

    return new Response(JSON.stringify({ key: keyData.key }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})

async function checkQuota(sb: any, userId: string): Promise<boolean> {
  const { data: profile } = await sb.from('profiles').select('is_premium').eq('id', userId).single()
  if (profile?.is_premium) return true

  const period = new Date().toISOString().substring(0, 7)
  const { data: usage } = await sb.from('usage').select('count').eq('user_id', userId).eq('period', period).single()

  return !usage || usage.count < 15
}

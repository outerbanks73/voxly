// Voxly - Cloud Sync
// Handles uploading transcripts to Supabase and offline retry queue.
// Requires: supabase.js, cloud-auth.js, config.js

// Upload a transcript to Supabase cloud storage
async function syncTranscriptToCloud(result, metadata) {
  if (!await canUseCloudFeatures()) return null;

  const sb = getSupabase();
  const user = await getCloudUser();
  if (!user) return null;

  const row = {
    user_id: user.id,
    title: metadata.title || metadata.source || 'Untitled',
    source: metadata.source || null,
    source_type: metadata.source_type || null,
    uploader: metadata.uploader || null,
    duration_seconds: metadata.duration_seconds || null,
    duration_display: metadata.duration || null,
    language: metadata.language || 'en',
    model: metadata.model || null,
    word_count: result.full_text ? result.full_text.split(/\s+/).length : 0,
    extraction_method: metadata.extraction_method || 'whisper',
    full_text: result.full_text,
    segments: result.segments || [],
    speakers: result.speakers || [],
    diarization_status: result.diarization_status || null,
    summary: metadata.summary || null,
    processed_at: metadata.processed_at || new Date().toISOString()
  };

  const { data, error } = await sb.from('transcripts').insert(row).select('id').single();

  if (error) throw error;

  // Store the cloud transcript ID locally for linking
  await chrome.storage.local.set({ currentCloudTranscriptId: data.id });
  return data.id;
}

// Update an existing cloud transcript (after editing)
async function updateCloudTranscript(transcriptId, updates) {
  const sb = getSupabase();
  const { error } = await sb.from('transcripts').update(updates).eq('id', transcriptId);
  if (error) throw error;
}

// Try to sync, queue on failure
async function trySyncOrQueue(result, metadata) {
  try {
    const id = await syncTranscriptToCloud(result, metadata);
    if (id) {
      console.log('[Voxly] Transcript synced to cloud:', id);
    }
    return id;
  } catch (e) {
    console.log('[Voxly] Cloud sync failed, queuing for retry:', e.message);
    await addToSyncQueue(result, metadata);
    return null;
  }
}

// Add a failed sync to the retry queue
async function addToSyncQueue(result, metadata) {
  const { pendingSyncQueue = [] } = await chrome.storage.local.get(['pendingSyncQueue']);
  pendingSyncQueue.push({
    result,
    metadata,
    retryCount: 0,
    lastAttempt: Date.now()
  });
  await chrome.storage.local.set({ pendingSyncQueue });
}

// Retry all pending syncs (called by background alarm)
async function retryPendingSyncs() {
  const { pendingSyncQueue = [] } = await chrome.storage.local.get(['pendingSyncQueue']);
  if (pendingSyncQueue.length === 0) return;

  if (!await canUseCloudFeatures()) return;

  const remaining = [];
  for (const item of pendingSyncQueue) {
    try {
      await syncTranscriptToCloud(item.result, item.metadata);
      console.log('[Voxly] Retried sync succeeded');
    } catch (e) {
      if (item.retryCount < 10) {
        remaining.push({
          ...item,
          retryCount: item.retryCount + 1,
          lastAttempt: Date.now()
        });
      } else {
        console.log('[Voxly] Dropping sync item after 10 retries');
      }
    }
  }
  await chrome.storage.local.set({ pendingSyncQueue: remaining });
}

// Fetch transcript library from cloud
async function fetchCloudTranscripts(page = 1, pageSize = 20, searchQuery = '') {
  const sb = getSupabase();
  const user = await getCloudUser();
  if (!user) return { data: [], count: 0 };

  const offset = (page - 1) * pageSize;

  let query = sb
    .from('transcripts')
    .select('id, title, source, source_type, duration_display, word_count, language, created_at, is_public, share_token', { count: 'exact' })
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (searchQuery) {
    query = query.textSearch('full_text', searchQuery, { type: 'websearch' });
  }

  const { data, count, error } = await query;
  if (error) throw error;
  return { data: data || [], count: count || 0 };
}

// Fetch transcripts shared with the current user
async function fetchSharedTranscripts(page = 1, pageSize = 20) {
  const sb = getSupabase();
  const user = await getCloudUser();
  if (!user) return { data: [], count: 0 };

  const offset = (page - 1) * pageSize;

  const { data, count, error } = await sb
    .from('transcript_shares')
    .select(`
      transcript:transcripts (
        id, title, source, source_type, duration_display, word_count, language, created_at
      ),
      shared_by:profiles!transcript_shares_shared_by_fkey (display_name, email),
      permission,
      created_at
    `, { count: 'exact' })
    .eq('shared_with', user.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (error) throw error;
  return { data: data || [], count: count || 0 };
}

// Toggle public sharing on a transcript
async function togglePublicShare(transcriptId, makePublic) {
  const sb = getSupabase();

  if (makePublic) {
    // Generate a random share token
    const token = crypto.randomUUID().replace(/-/g, '').substring(0, 16);
    const { error } = await sb.from('transcripts')
      .update({ is_public: true, share_token: token })
      .eq('id', transcriptId);
    if (error) throw error;
    return token;
  } else {
    const { error } = await sb.from('transcripts')
      .update({ is_public: false, share_token: null })
      .eq('id', transcriptId);
    if (error) throw error;
    return null;
  }
}

// Share a transcript with another user by email
async function shareTranscriptWithUser(transcriptId, email, permission = 'read') {
  const sb = getSupabase();
  const currentUser = await getCloudUser();
  if (!currentUser) throw new Error('Not authenticated');

  // Look up the target user by email in profiles
  const { data: profile, error: lookupError } = await sb
    .from('profiles')
    .select('id')
    .eq('email', email)
    .single();

  if (lookupError || !profile) {
    throw new Error('User not found. They must have a Voxly cloud account.');
  }

  if (profile.id === currentUser.id) {
    throw new Error('You cannot share with yourself.');
  }

  const { error } = await sb.from('transcript_shares').upsert({
    transcript_id: transcriptId,
    shared_by: currentUser.id,
    shared_with: profile.id,
    permission: permission
  }, { onConflict: 'transcript_id,shared_with' });

  if (error) throw error;
}

// Get active shares for a transcript
async function getTranscriptShares(transcriptId) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('transcript_shares')
    .select(`
      id,
      shared_with,
      permission,
      created_at,
      profile:profiles!transcript_shares_shared_with_fkey (display_name, email)
    `)
    .eq('transcript_id', transcriptId);

  if (error) throw error;
  return data || [];
}

// Revoke a share
async function revokeTranscriptShare(shareId) {
  const sb = getSupabase();
  const { error } = await sb.from('transcript_shares').delete().eq('id', shareId);
  if (error) throw error;
}

// Fetch a public transcript by share token (no auth required)
async function fetchPublicTranscript(shareToken) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('transcripts')
    .select('*')
    .eq('share_token', shareToken)
    .eq('is_public', true)
    .single();

  if (error) throw error;
  return data;
}

// Fetch a single transcript by ID
async function fetchCloudTranscript(transcriptId) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('transcripts')
    .select('*')
    .eq('id', transcriptId)
    .single();

  if (error) throw error;
  return data;
}

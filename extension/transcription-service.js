// Voxly - Transcription Service
// Cloud transcription via Supabase Edge Functions.
// Requires: config.js (SUPABASE_FUNCTIONS_URL), supabase.js, cloud-auth.js

const transcriptionService = {

  // Transcribe an audio/video file via Deepgram Nova-2
  async transcribeFile(file, onProgress) {
    if (onProgress) onProgress('Uploading to cloud...');

    // Upload file to Supabase Storage first
    const storagePath = await this.uploadToStorage(file);

    if (onProgress) onProgress('Transcribing with Deepgram Nova-2...');

    // Call Edge Function with storage path
    const result = await this.callEdgeFunction('transcribe', { storagePath });
    return result;
  },

  // Transcribe a URL via Supadata
  async transcribeUrl(url, onProgress) {
    if (onProgress) onProgress('Sending URL to transcription service...');

    const result = await this.callEdgeFunction('transcribe-url', { url });

    // Handle async jobs (long videos)
    if (result.jobId) {
      if (onProgress) onProgress('Processing long video...');
      return await this.pollSupadataJob(result.jobId, onProgress);
    }

    return result;
  },

  // Transcribe a recording blob (wraps as file upload)
  async transcribeRecording(blob, onProgress) {
    const file = new File([blob], 'recording.webm', { type: 'audio/webm' });
    return await this.transcribeFile(file, onProgress);
  },

  // Get temporary Deepgram API key for realtime streaming
  async getRealtimeToken() {
    return await this.callEdgeFunction('realtime-token', {});
  },

  // Upload file to Supabase Storage (audio-files bucket)
  async uploadToStorage(file) {
    // Ensure session is fresh before upload (prevents stale token errors)
    const session = await ensureValidSession();
    if (!session) throw new Error('Session expired. Please sign in again in Settings.');

    const sb = getSupabase();
    const user = await getCloudUser();
    if (!user) throw new Error('Not authenticated');

    // Check file size (Supabase Storage limit: 50MB)
    const MAX_FILE_SIZE = 50 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      throw new Error(`File too large (${sizeMB} MB). Maximum size is 50 MB. Try compressing the file or using a shorter clip.`);
    }

    const ext = (file.name.split('.').pop() || 'webm').toLowerCase();
    const path = `${user.id}/${Date.now()}.${ext}`;

    // Resolve MIME type from extension if browser reports generic octet-stream
    let contentType = file.type;
    if (!contentType || contentType === 'application/octet-stream') {
      const mimeMap = {
        mp3: 'audio/mpeg', mp4: 'video/mp4', m4a: 'audio/mp4',
        wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg',
        flac: 'audio/flac', aac: 'audio/aac', wma: 'audio/x-ms-wma',
        avi: 'video/x-msvideo', mkv: 'video/x-matroska', mov: 'video/quicktime',
        mpg: 'video/mpeg', mpeg: 'video/mpeg', ts: 'video/mp2t',
        '3gp': 'video/3gpp', opus: 'audio/opus'
      };
      contentType = mimeMap[ext] || 'audio/mpeg';
    }

    console.log(`[Voxly] Uploading file: ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB, type: ${contentType})`);

    try {
      const { error } = await sb.storage
        .from('audio-files')
        .upload(path, file, { contentType });

      if (error) throw new Error(`Upload failed: ${error.message}`);
      return path;
    } catch (e) {
      if (e.message.includes('Failed to fetch')) {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        throw new Error(`Upload failed — could not connect to cloud storage. File: ${sizeMB} MB. Check your internet connection and try again.`);
      }
      throw e;
    }
  },

  // Generic Edge Function caller with JWT auth
  async callEdgeFunction(name, body) {
    // Ensure session is fresh (auto-refresh if expired)
    const session = await ensureValidSession();
    if (!session?.access_token) {
      throw new Error('Session expired. Please sign in again in Settings.');
    }

    const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Edge Function error: ${response.status}`);
    }

    return await response.json();
  },

  // Poll Supadata async job until complete
  async pollSupadataJob(jobId, onProgress) {
    const maxAttempts = 120; // 10 minutes at 5s intervals
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 5000));

      if (onProgress) onProgress(`Processing... (${i * 5}s elapsed)`);

      const result = await this.callEdgeFunction('transcribe-url', {
        jobId,
        poll: true
      });

      if (result.status === 'completed') {
        return result;
      } else if (result.status === 'error') {
        throw new Error(result.error || 'Transcription failed');
      }
      // Otherwise keep polling
    }
    throw new Error('Transcription timed out after 10 minutes');
  }
};

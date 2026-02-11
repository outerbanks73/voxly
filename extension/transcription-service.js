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
    const sb = getSupabase();
    const user = await getCloudUser();
    if (!user) throw new Error('Not authenticated');

    const ext = file.name.split('.').pop() || 'webm';
    const path = `${user.id}/${Date.now()}.${ext}`;

    const { error } = await sb.storage
      .from('audio-files')
      .upload(path, file, { contentType: file.type });

    if (error) throw new Error(`Upload failed: ${error.message}`);
    return path;
  },

  // Generic Edge Function caller with JWT auth
  async callEdgeFunction(name, body) {
    const session = await getCloudSession();
    if (!session?.access_token) {
      throw new Error('Not authenticated. Please sign in.');
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

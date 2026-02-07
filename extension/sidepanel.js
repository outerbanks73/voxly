// SpeakToText Local - Side Panel Script

const SERVER_URL = 'http://localhost:5123';

// State
let currentJobId = null;
let pollInterval = null;
let selectedFile = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = null;
let recordingTimer = null;
let currentResult = null; // Store the result for export
let currentMetadata = null; // Store metadata for enriched exports
let realtimeSessionId = null;
let realtimeChunkInterval = null;
let isRealtimeMode = false;

// DOM Elements
const statusBar = document.getElementById('statusBar');
const statusText = document.getElementById('statusText');
const errorMessage = document.getElementById('errorMessage');
const progressSection = document.getElementById('progressSection');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const resultSection = document.getElementById('resultSection');

// Streaming site patterns to auto-populate URL
const STREAMING_SITES = [
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'twitch.tv',
  'dailymotion.com',
  'soundcloud.com',
  'spotify.com',
  'podcasts.apple.com',
  'podcasts.google.com',
  'anchor.fm',
  'buzzsprout.com',
  'transistor.fm',
  'simplecast.com',
  'libsyn.com',
  'podbean.com',
  'spreaker.com',
  'audioboom.com',
  'megaphone.fm',
  'acast.com',
  'stitcher.com',
  'overcast.fm',
  'pocketcasts.com',
  'castbox.fm',
  'player.fm',
  'radiopublic.com',
  'pandora.com',
  'iheart.com',
  'tunein.com',
  'deezer.com',
  'tidal.com',
  'bandcamp.com',
  'mixcloud.com',
  'audiomack.com'
];

// Current extension version
const CURRENT_VERSION = '1.5.6';
const GITHUB_REPO = 'outerbanks73/speaktotext-local';

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await checkServerConnection();
  setupTabs();
  setupFileUpload();
  setupButtons();
  await autoPopulateUrl();
  checkForUpdates();
  await checkActiveJob(); // Check if there's an in-progress job from before
});

// Check server connection
async function checkServerConnection() {
  try {
    const response = await fetch(`${SERVER_URL}/health`, { method: 'GET' });
    if (response.ok) {
      statusBar.className = 'status-bar connected';
      statusText.textContent = 'Server connected';
      return true;
    }
  } catch (e) {
    // Connection failed
  }

  statusBar.className = 'status-bar disconnected';
  statusText.textContent = 'Server not running. Start the local server first.';
  return false;
}

// Tab navigation
function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

// File upload handling
function setupFileUpload() {
  const fileInput = document.getElementById('fileInput');
  const fileDropZone = document.getElementById('fileDropZone');
  const fileName = document.getElementById('fileName');
  const transcribeBtn = document.getElementById('transcribeFileBtn');

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      selectedFile = e.target.files[0];
      fileName.textContent = selectedFile.name;
      fileName.style.display = 'block';
      fileDropZone.querySelector('.text').style.display = 'none';
      fileDropZone.querySelector('.icon').textContent = '✅';
      fileDropZone.classList.add('has-file');
      transcribeBtn.disabled = false;
    }
  });

  // Drag and drop
  fileDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    fileDropZone.style.borderColor = '#da7756';
  });

  fileDropZone.addEventListener('dragleave', () => {
    fileDropZone.style.borderColor = '#e5e2de';
  });

  fileDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    fileDropZone.style.borderColor = '#e5e2de';
    if (e.dataTransfer.files.length > 0) {
      fileInput.files = e.dataTransfer.files;
      fileInput.dispatchEvent(new Event('change'));
    }
  });
}

// Button handlers
function setupButtons() {
  // Transcribe file
  document.getElementById('transcribeFileBtn').addEventListener('click', async () => {
    if (!selectedFile) return;
    await transcribeFile(selectedFile);
  });

  // Transcribe URL
  document.getElementById('transcribeUrlBtn').addEventListener('click', async () => {
    const url = document.getElementById('urlInput').value.trim();
    if (!url) {
      showError('Please enter a URL');
      return;
    }
    await transcribeUrl(url);
  });

  // Recording
  document.getElementById('startRecordBtn').addEventListener('click', startRecording);
  document.getElementById('stopRecordBtn').addEventListener('click', stopRecording);

  // Open transcript management page
  document.getElementById('openTranscriptBtn').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'transcript.html' });
  });
}

// Get HF token from storage
async function getHfToken() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['hfToken'], (result) => {
      resolve(result.hfToken || '');
    });
  });
}

// Transcribe file with auto model selection
async function transcribeFile(file) {
  const connected = await checkServerConnection();
  if (!connected) {
    showError('Server not running. Please start the local server first.');
    return;
  }

  hideError();
  showProgress('Uploading file...');

  // Use 'base' as default for files (server will handle it)
  const model = 'base';

  // Initialize metadata for this transcription
  currentMetadata = {
    source: file.name,
    source_type: 'file',
    model: model,
    processed_at: new Date().toISOString()
  };

  const formData = new FormData();
  formData.append('file', file);
  formData.append('model', model);

  const hfToken = await getHfToken();
  if (hfToken) {
    formData.append('hf_token', hfToken);
  }

  try {
    const response = await fetch(`${SERVER_URL}/transcribe/file`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    if (data.job_id) {
      currentJobId = data.job_id;
      // Hand off to background for persistent polling
      chrome.runtime.sendMessage({
        action: 'trackJob',
        jobId: data.job_id,
        metadata: currentMetadata
      });
      startProgressPolling();
    } else {
      showError('Failed to start transcription');
      hideProgress();
    }
  } catch (e) {
    showError(`Error: ${e.message}`);
    hideProgress();
  }
}

// Pre-flight check to get video duration and info
async function preflightCheck(url) {
  try {
    const formData = new FormData();
    formData.append('url', url);

    const response = await fetch(`${SERVER_URL}/transcribe/preflight`, {
      method: 'POST',
      body: formData
    });

    return await response.json();
  } catch (e) {
    console.error('Preflight check failed:', e);
    return { error: e.message };
  }
}

// Show pre-flight confirmation dialog for long videos
function showPreflightDialog(preflight) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('preflightDialog');
    const title = document.getElementById('preflightTitle');
    const duration = document.getElementById('preflightDuration');
    const estimate = document.getElementById('preflightEstimate');
    const confirmBtn = document.getElementById('preflightConfirm');
    const cancelBtn = document.getElementById('preflightCancel');

    // Truncate title if too long
    const displayTitle = preflight.title.length > 40
      ? preflight.title.substring(0, 37) + '...'
      : preflight.title;

    title.textContent = displayTitle;
    duration.textContent = preflight.duration_formatted;

    // Show estimate for recommended model
    const recommendedModel = preflight.recommended_model;
    const estTime = preflight.estimates[recommendedModel]?.formatted || 'Unknown';
    estimate.textContent = `~${estTime}`;

    dialog.style.display = 'flex';

    const cleanup = () => {
      dialog.style.display = 'none';
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
    };

    confirmBtn.onclick = () => {
      cleanup();
      resolve(preflight);
    };

    cancelBtn.onclick = () => {
      cleanup();
      resolve(null);
    };
  });
}

// Transcribe URL with smart model selection
async function transcribeUrl(url) {
  const connected = await checkServerConnection();
  if (!connected) {
    showError('Server not running. Please start the local server first.');
    return;
  }

  hideError();
  showProgress('Checking video info...');

  // Do preflight check to get duration
  const preflight = await preflightCheck(url);

  // Always show preflight dialog before transcription
  hideProgress();
  const confirmed = await showPreflightDialog(preflight);
  if (!confirmed) {
    return; // User cancelled
  }
  showProgress('Starting transcription...');

  // Initialize metadata for this transcription
  const model = preflight.recommended_model || 'base';
  currentMetadata = {
    source: url,
    source_type: 'url',
    model: model,
    duration_seconds: preflight.duration_seconds,
    title: preflight.title,
    processed_at: new Date().toISOString()
  };

  const formData = new FormData();
  formData.append('url', url);
  formData.append('model', 'auto'); // Let server pick the model

  // Pass duration if we have it (enables smart selection on server)
  if (preflight.duration_seconds) {
    formData.append('duration_seconds', preflight.duration_seconds);
  }

  const hfToken = await getHfToken();
  if (hfToken) {
    formData.append('hf_token', hfToken);
  }

  try {
    const response = await fetch(`${SERVER_URL}/transcribe/url`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    if (data.job_id) {
      currentJobId = data.job_id;

      // Update metadata with server's model choice
      if (data.model) {
        currentMetadata.model = data.model;
      }

      // Hand off to background for persistent polling
      chrome.runtime.sendMessage({
        action: 'trackJob',
        jobId: data.job_id,
        metadata: currentMetadata
      });
      startProgressPolling();
    } else {
      showError(data.error || 'Failed to start transcription');
      hideProgress();
    }
  } catch (e) {
    showError(`Error: ${e.message}`);
    hideProgress();
  }
}

// Start recording tab audio
async function startRecording() {
  const mode = document.getElementById('recordingMode').value;
  isRealtimeMode = (mode === 'realtime');

  try {
    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Request tab capture
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });

    recordedChunks = [];

    if (isRealtimeMode) {
      // Real-time mode: start session and send chunks periodically
      await startRealtimeSession(stream);
    } else {
      // Standard mode: record everything, transcribe at end
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          recordedChunks.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        const blob = new Blob(recordedChunks, { type: 'audio/webm' });
        await transcribeRecording(blob);
      };

      mediaRecorder.start(1000); // Collect data every second
    }

    recordingStartTime = Date.now();

    // Update UI
    document.getElementById('startRecordBtn').style.display = 'none';
    document.getElementById('stopRecordBtn').style.display = 'block';
    document.getElementById('recordingIndicator').classList.add('active');

    if (isRealtimeMode) {
      document.getElementById('realtimeTranscript').style.display = 'block';
      document.getElementById('realtimeTranscript').innerHTML = '<em style="color: #999;">Listening...</em>';
    }

    // Start timer
    recordingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const secs = (elapsed % 60).toString().padStart(2, '0');
      document.getElementById('recordingTime').textContent = `${mins}:${secs}`;
    }, 1000);

  } catch (e) {
    showError(`Recording failed: ${e.message}`);
  }
}

// Start real-time transcription session
async function startRealtimeSession(stream) {
  // Use 'tiny' for real-time mode (needs to be fast)
  const model = 'tiny';

  try {
    // Start session on server
    const formData = new FormData();
    formData.append('model', model);

    const response = await fetch(`${SERVER_URL}/transcribe/realtime/start`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    realtimeSessionId = data.session_id;

    // Create media recorder for chunks
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    let chunkBuffer = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunkBuffer.push(e.data);
        recordedChunks.push(e.data); // Also keep for final transcript
      }
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(track => track.stop());
      await stopRealtimeSession();
    };

    // Start recording with smaller chunks for real-time
    mediaRecorder.start(1000);

    // Send chunks every 5 seconds for transcription
    realtimeChunkInterval = setInterval(async () => {
      if (chunkBuffer.length > 0 && realtimeSessionId) {
        const blob = new Blob(chunkBuffer, { type: 'audio/webm' });
        chunkBuffer = [];

        try {
          const formData = new FormData();
          formData.append('chunk', blob, 'chunk.webm');

          const response = await fetch(`${SERVER_URL}/transcribe/realtime/chunk/${realtimeSessionId}`, {
            method: 'POST',
            body: formData
          });

          const result = await response.json();
          if (result.transcript) {
            updateRealtimeTranscript(result.all_transcripts);
          }
        } catch (e) {
          console.error('Chunk transcription error:', e);
        }
      }
    }, 5000);

  } catch (e) {
    showError(`Real-time session failed: ${e.message}`);
  }
}

// Update real-time transcript display
function updateRealtimeTranscript(transcripts) {
  const container = document.getElementById('realtimeTranscript');
  if (transcripts && transcripts.length > 0) {
    container.textContent = transcripts.join(' ');
    container.scrollTop = container.scrollHeight;
  }
}

// Stop real-time session
async function stopRealtimeSession() {
  clearInterval(realtimeChunkInterval);
  realtimeChunkInterval = null;

  if (realtimeSessionId) {
    try {
      const response = await fetch(`${SERVER_URL}/transcribe/realtime/stop/${realtimeSessionId}`, {
        method: 'POST'
      });

      const result = await response.json();

      // Show final result
      if (result.full_transcript) {
        currentResult = {
          full_text: result.full_transcript,
          segments: result.segments.map((text, i) => ({
            timestamp: formatTime(i * 5),
            text: text
          }))
        };
        showResult(currentResult);
      }
    } catch (e) {
      console.error('Stop session error:', e);
    }

    realtimeSessionId = null;
  }

  document.getElementById('realtimeTranscript').style.display = 'none';
}

// Format seconds to MM:SS
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

// Stop recording
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  clearInterval(recordingTimer);
  clearInterval(realtimeChunkInterval);

  document.getElementById('startRecordBtn').style.display = 'block';
  document.getElementById('stopRecordBtn').style.display = 'none';
  document.getElementById('recordingIndicator').classList.remove('active');

  isRealtimeMode = false;
}

// Transcribe recording
async function transcribeRecording(blob) {
  const connected = await checkServerConnection();
  if (!connected) {
    showError('Server not running. Please start the local server first.');
    return;
  }

  hideError();
  showProgress('Uploading recording...');

  const recordingDuration = recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : null;

  // Smart model selection based on recording duration
  // Short recordings get better quality, long recordings need to be fast
  let model = 'base';
  if (recordingDuration && recordingDuration > 1800) {
    model = 'tiny'; // > 30 min: use tiny for speed
  }

  // Initialize metadata for this transcription
  currentMetadata = {
    source: 'Tab Recording',
    source_type: 'recording',
    model: model,
    duration: recordingDuration,
    processed_at: new Date().toISOString()
  };

  const formData = new FormData();
  formData.append('file', blob, 'recording.webm');
  formData.append('model', model);

  const hfToken = await getHfToken();
  if (hfToken) {
    formData.append('hf_token', hfToken);
  }

  try {
    const response = await fetch(`${SERVER_URL}/transcribe/file`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    if (data.job_id) {
      currentJobId = data.job_id;
      // Hand off to background for persistent polling
      chrome.runtime.sendMessage({
        action: 'trackJob',
        jobId: data.job_id,
        metadata: currentMetadata
      });
      startProgressPolling();
    } else {
      showError('Failed to start transcription');
      hideProgress();
    }
  } catch (e) {
    showError(`Error: ${e.message}`);
    hideProgress();
  }
}

// Check if there's an active job from background (e.g., from before panel closed)
async function checkActiveJob() {
  try {
    // First check background worker for in-progress jobs
    const response = await chrome.runtime.sendMessage({ action: 'getJobStatus' });
    if (response.job) {
      const job = response.job;
      currentJobId = job.id;
      currentMetadata = job.metadata;

      if (job.status === 'completed') {
        // Job finished while panel was closed
        currentResult = job.result;
        showResult(job.result);
        return;
      } else if (job.status === 'error') {
        showError(job.error);
        return;
      } else if (job.status === 'processing') {
        // Job still in progress, resume showing progress
        showProgress(job.progress, job.stage);
        startProgressPolling();
        return;
      }
    }
  } catch (e) {
    // Background not ready yet, continue to check storage
  }

  // Check storage for completed transcripts that weren't displayed
  // (handles case where Chrome restarted the service worker during long transcriptions)
  try {
    const stored = await chrome.storage.local.get(['transcriptResult', 'transcriptMetadata']);
    if (stored.transcriptResult) {
      currentResult = stored.transcriptResult;
      currentMetadata = stored.transcriptMetadata || {};
      showResult(stored.transcriptResult);
    }
  } catch (e) {
    console.log('Error checking storage for transcript:', e);
  }
}

// Start polling background for job status (UI updates only)
function startProgressPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
  }

  pollInterval = setInterval(async () => {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getJobStatus' });
      if (!response.job) {
        clearInterval(pollInterval);
        return;
      }

      const job = response.job;

      if (job.status === 'completed') {
        clearInterval(pollInterval);
        hideProgress();
        currentResult = job.result;
        currentMetadata = job.metadata;
        showResult(job.result);
      } else if (job.status === 'error') {
        clearInterval(pollInterval);
        hideProgress();
        showError(job.error);
      } else {
        // Update progress UI
        const stage = job.stage || 'processing';
        const progress = job.progress || 'Processing...';
        const downloadPercent = job.downloadPercent;

        // Update progress bar for download stage
        if (stage === 'downloading' && downloadPercent !== undefined) {
          progressBar.classList.remove('indeterminate');
          progressBar.style.width = `${downloadPercent}%`;
        } else {
          progressBar.classList.add('indeterminate');
          progressBar.style.width = '';
        }

        updateProgress(progress, stage);
      }
    } catch (e) {
      // Background not responding, will retry
    }
  }, 500);
}

// UI helpers
function showError(message) {
  errorMessage.textContent = message;
  errorMessage.style.display = 'block';
}

function hideError() {
  errorMessage.style.display = 'none';
}

function showProgress(text) {
  progressSection.classList.add('active');
  progressText.textContent = text;
  progressBar.classList.add('indeterminate');
}

function updateProgress(text, stage = '') {
  progressText.textContent = text;

  // Update stage indicator if we have one
  const stageIndicator = document.getElementById('stageIndicator');
  if (stageIndicator && stage) {
    const stageLabels = {
      'queued': '⏳ Queued',
      'downloading': '⬇️ Downloading',
      'converting': '🔄 Converting',
      'transcribing': '🎤 Transcribing',
      'diarizing': '👥 Identifying Speakers',
      'complete': '✅ Complete'
    };
    stageIndicator.textContent = stageLabels[stage] || stage;
  }
}

function hideProgress() {
  progressSection.classList.remove('active');
}

async function showResult(result) {
  resultSection.classList.add('active');
  currentResult = result; // Store for export

  // Save transcript data to storage for the transcript page
  await chrome.storage.local.set({
    transcriptResult: result,
    transcriptMetadata: currentMetadata
  });
}

// Auto-populate URL field with current tab URL
async function autoPopulateUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;

    // Skip chrome:// and other internal URLs
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://')) {
      return;
    }

    // Always populate the URL field with the current tab
    document.getElementById('urlInput').value = tab.url;
  } catch (e) {
    // Silently fail if we can't get the tab URL
  }
}

// Check for updates from GitHub
async function checkForUpdates() {
  try {
    // Only check once per day
    const lastCheck = localStorage.getItem('lastUpdateCheck');
    const now = Date.now();
    if (lastCheck && (now - parseInt(lastCheck)) < 24 * 60 * 60 * 1000) {
      // Check if we already know about an update
      const knownUpdate = localStorage.getItem('availableUpdate');
      if (knownUpdate && compareVersions(knownUpdate, CURRENT_VERSION) > 0) {
        showUpdateBanner(knownUpdate);
      }
      return;
    }

    // Fetch latest release from GitHub API
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github.v3+json' }
    });

    if (!response.ok) {
      // Try fetching the manifest from main branch as fallback
      const manifestResponse = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/extension/manifest.json`);
      if (manifestResponse.ok) {
        const manifest = await manifestResponse.json();
        const latestVersion = manifest.version;
        localStorage.setItem('lastUpdateCheck', now.toString());

        if (compareVersions(latestVersion, CURRENT_VERSION) > 0) {
          localStorage.setItem('availableUpdate', latestVersion);
          showUpdateBanner(latestVersion);
        }
      }
      return;
    }

    const release = await response.json();
    const latestVersion = release.tag_name.replace(/^v/, '');
    localStorage.setItem('lastUpdateCheck', now.toString());

    if (compareVersions(latestVersion, CURRENT_VERSION) > 0) {
      localStorage.setItem('availableUpdate', latestVersion);
      showUpdateBanner(latestVersion);
    }
  } catch (e) {
    // Silently fail - update check is non-critical
    console.log('Update check failed:', e.message);
  }
}

// Compare semantic versions (returns 1 if a > b, -1 if a < b, 0 if equal)
function compareVersions(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

// Show update banner
function showUpdateBanner(version) {
  const banner = document.getElementById('updateBanner');
  const text = document.getElementById('updateText');
  if (banner && text) {
    text.textContent = `v${version} available!`;
    banner.style.display = 'block';
  }
}

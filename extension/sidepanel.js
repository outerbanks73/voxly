// Voxly - Side Panel Script

// ExtensionPay for premium subscriptions
const extpay = ExtPay('voxly'); // TODO: Replace with your ExtensionPay extension ID

// State
let selectedFile = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = null;
let recordingTimer = null;
let currentResult = null; // Store the result for export
let currentMetadata = null; // Store metadata for enriched exports
let isRealtimeMode = false;
let detectedVideoTitle = null;

// Realtime WebSocket state
let realtimeSocket = null;
let realtimeAudioContext = null;
let realtimeProcessor = null;
let realtimeSegments = [];

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
  'audiomack.com',
  'tiktok.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'facebook.com'
];

// CURRENT_VERSION and GITHUB_REPO are defined in config.js

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await checkCloudStatusAndUpdateUI();
  setupTabs();
  setupFileUpload();
  setupButtons();
  setupUpgradeModal();
  setupUrlTitlePreview();
  await autoPopulateUrl();
  await updateUsageIndicator();
  checkForUpdates();
  updateLibraryLink(); // Show library link if cloud user

  // Listen for auth state changes broadcast from options page or background
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'cloudAuthStateChanged') {
      checkCloudStatusAndUpdateUI();
      updateLibraryLink();
      updateUsageIndicator();
    }
  });

  // Retry auth check — Supabase async storage adapter may not be ready yet
  setTimeout(async () => {
    const currentStatus = statusText.textContent;
    if (currentStatus === 'Sign in required') {
      await checkCloudStatusAndUpdateUI();
      updateLibraryLink();
    }
  }, 1500);
});

// Check if user is premium subscriber
async function isPremiumUser() {
  try {
    const user = await extpay.getUser();
    return user.paid === true;
  } catch (e) {
    console.log('ExtPay check failed:', e);
    return false;
  }
}

// Check usage limit for free tier
async function checkUsageLimit() {
  // Premium users have unlimited access
  if (await isPremiumUser()) {
    return true;
  }

  // Check free tier usage
  const { usageCount = 0, usagePeriodStart } = await chrome.storage.local.get(['usageCount', 'usagePeriodStart']);

  // Reset if new month
  const now = new Date();
  const periodStart = usagePeriodStart ? new Date(usagePeriodStart) : null;
  if (!periodStart || now.getMonth() !== periodStart.getMonth() || now.getFullYear() !== periodStart.getFullYear()) {
    await chrome.storage.local.set({
      usageCount: 0,
      usagePeriodStart: now.toISOString()
    });
    await updateUsageIndicator();
    return true;
  }

  // Check limit
  if (usageCount >= FREE_LIMIT) {
    showUpgradeModal();
    return false;
  }

  return true;
}

// Increment usage count after successful transcription
async function incrementUsage() {
  const { usageCount = 0 } = await chrome.storage.local.get(['usageCount']);
  await chrome.storage.local.set({ usageCount: usageCount + 1 });
  await updateUsageIndicator();
}

// Update usage indicator in UI
async function updateUsageIndicator() {
  const indicator = document.getElementById('usageIndicator');
  const usageText = document.getElementById('usageText');
  const upgradeLink = document.getElementById('upgradeLink');

  if (!indicator || !usageText) return;

  // Premium users don't see usage indicator
  if (await isPremiumUser()) {
    indicator.style.display = 'none';
    return;
  }

  const { usageCount = 0 } = await chrome.storage.local.get(['usageCount']);
  const remaining = FREE_LIMIT - usageCount;

  indicator.style.display = 'flex';
  usageText.textContent = `${usageCount} of ${FREE_LIMIT} free transcriptions used`;

  // Add warning color when low
  if (remaining <= 3) {
    indicator.classList.add('low');
  } else {
    indicator.classList.remove('low');
  }

  // Setup upgrade link click
  if (upgradeLink) {
    upgradeLink.onclick = (e) => {
      e.preventDefault();
      showUpgradeModal();
    };
  }
}

// Setup upgrade modal
function setupUpgradeModal() {
  const modal = document.getElementById('upgradeModal');
  const closeBtn = document.getElementById('closeUpgradeModal');
  const subscribeBtn = document.getElementById('subscribeBtn');

  if (closeBtn) {
    closeBtn.onclick = () => {
      modal.style.display = 'none';
    };
  }

  if (subscribeBtn) {
    subscribeBtn.onclick = () => {
      extpay.openPaymentPage();
      modal.style.display = 'none';
    };
  }

  // Close on overlay click
  if (modal) {
    modal.onclick = (e) => {
      if (e.target === modal) {
        modal.style.display = 'none';
      }
    };
  }
}

// Show upgrade modal
function showUpgradeModal() {
  const modal = document.getElementById('upgradeModal');
  if (modal) {
    modal.style.display = 'flex';
  }
}

// Check cloud authentication status and update UI
async function checkCloudStatusAndUpdateUI() {
  const signInLink = 'Sign in required. <a href="options.html" target="_blank" style="color:inherit;text-decoration:underline;">Click here</a>';
  try {
    const authenticated = await isCloudAuthenticated();
    if (authenticated) {
      statusBar.className = 'status-bar connected';
      statusText.textContent = 'Cloud ready';
    } else {
      statusBar.className = 'status-bar disconnected';
      statusText.innerHTML = signInLink;
    }
    return authenticated;
  } catch (e) {
    statusBar.className = 'status-bar disconnected';
    statusText.innerHTML = signInLink;
    return false;
  }
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

// Transcribe file via cloud (Deepgram Nova-2)
async function transcribeFile(file) {
  if (!await checkUsageLimit()) return;

  const authenticated = await isCloudAuthenticated();
  if (!authenticated) {
    showError('Please sign in to use cloud transcription. <a href="options.html" target="_blank" style="color:#0080FF;text-decoration:underline;">Open Settings to sign in</a>', true);
    return;
  }

  hideError();
  hideResult();
  currentResult = null;
  currentMetadata = null;
  showProgress('Uploading file...');

  currentMetadata = {
    source: file.name,
    source_type: 'file',
    extraction_method: 'cloud',
    processed_at: new Date().toISOString()
  };

  try {
    const result = await transcriptionService.transcribeFile(file, (progress) => {
      updateProgress(progress);
    });

    hideProgress();
    currentResult = result;

    if (result.language) currentMetadata.language = result.language;
    if (result.duration) currentMetadata.duration_seconds = result.duration;

    await chrome.storage.local.set({
      transcriptResult: currentResult,
      transcriptMetadata: currentMetadata
    });

    showResult(currentResult);
    incrementUsage();
    trySyncOrQueue(currentResult, currentMetadata);
  } catch (e) {
    hideProgress();
    hideResult();
    showError(`Transcription failed: ${e.message}`);
  }
}

// Transcribe URL via cloud (Supadata)
async function transcribeUrl(url) {
  if (!await checkUsageLimit()) return;

  const authenticated = await isCloudAuthenticated();
  if (!authenticated) {
    showError('Please sign in to use cloud transcription. <a href="options.html" target="_blank" style="color:#0080FF;text-decoration:underline;">Open Settings to sign in</a>', true);
    return;
  }

  hideError();
  hideResult();
  currentResult = null;
  currentMetadata = null;
  showProgress('Transcribing URL...');

  currentMetadata = {
    source: url,
    source_type: 'url',
    extraction_method: 'cloud',
    processed_at: new Date().toISOString()
  };

  // Pre-populate title from URL detection if available
  if (detectedVideoTitle) {
    currentMetadata.title = detectedVideoTitle;
  }

  try {
    const result = await transcriptionService.transcribeUrl(url, (progress) => {
      updateProgress(progress);
    });

    hideProgress();
    currentResult = result;

    // API title overrides detected title if present
    if (result.title) currentMetadata.title = result.title;
    if (result.language) currentMetadata.language = result.language;
    if (result.duration) currentMetadata.duration_seconds = result.duration;

    await chrome.storage.local.set({
      transcriptResult: currentResult,
      transcriptMetadata: currentMetadata
    });

    showResult(currentResult);
    incrementUsage();
    trySyncOrQueue(currentResult, currentMetadata);
  } catch (e) {
    hideProgress();
    hideResult();
    showError(`Transcription failed: ${e.message}`);
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
      // Real-time mode: stream to Deepgram WebSocket
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

// Start real-time transcription session via Deepgram WebSocket
async function startRealtimeSession(stream) {
  try {
    // Get temporary Deepgram key from Edge Function
    const { key } = await transcriptionService.getRealtimeToken();

    // Open WebSocket to Deepgram
    const wsUrl = `${DEEPGRAM_WS_URL}?model=nova-2&interim_results=true&diarize=true&encoding=linear16&sample_rate=16000`;
    realtimeSocket = new WebSocket(wsUrl, ['token', key]);

    realtimeSegments = [];

    realtimeSocket.onopen = () => {
      console.log('[Voxly] Deepgram WebSocket connected');
    };

    realtimeSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'Results') {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (transcript && data.is_final) {
          realtimeSegments.push({
            text: transcript,
            start: data.start,
            end: data.start + data.duration
          });
          updateRealtimeTranscript(realtimeSegments);
        } else if (transcript) {
          // Interim result — show it as pending
          updateRealtimeTranscriptInterim(transcript);
        }
      }
    };

    realtimeSocket.onerror = (e) => {
      console.error('[Voxly] Deepgram WebSocket error:', e);
    };

    realtimeSocket.onclose = () => {
      console.log('[Voxly] Deepgram WebSocket closed');
    };

    // Create AudioContext at 16kHz and ScriptProcessorNode for PCM conversion
    realtimeAudioContext = new AudioContext({ sampleRate: 16000 });
    const source = realtimeAudioContext.createMediaStreamSource(stream);
    realtimeProcessor = realtimeAudioContext.createScriptProcessor(4096, 1, 1);

    realtimeProcessor.onaudioprocess = (e) => {
      if (realtimeSocket?.readyState === WebSocket.OPEN) {
        const float32 = e.inputBuffer.getChannelData(0);
        // Convert float32 to int16 PCM
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        realtimeSocket.send(int16.buffer);
      }
    };

    source.connect(realtimeProcessor);
    realtimeProcessor.connect(realtimeAudioContext.destination);

    // Also keep MediaRecorder for the full recording blob (standard stop path)
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.start(1000);

  } catch (e) {
    showError(`Real-time session failed: ${e.message}`);
  }
}

// Update real-time transcript display with final segments
function updateRealtimeTranscript(segments) {
  const container = document.getElementById('realtimeTranscript');
  container.textContent = '';
  segments.forEach((seg) => {
    const div = document.createElement('div');
    div.style.cssText = 'margin-bottom: 8px; padding: 4px 0; border-bottom: 1px solid #eee;';
    div.textContent = seg.text;
    container.appendChild(div);
  });
  container.scrollTop = container.scrollHeight;
}

// Show interim (non-final) transcript
function updateRealtimeTranscriptInterim(text) {
  const container = document.getElementById('realtimeTranscript');
  let interim = container.querySelector('.interim');
  if (!interim) {
    interim = document.createElement('div');
    interim.className = 'interim';
    interim.style.cssText = 'color: #999; font-style: italic; padding: 4px 0;';
    container.appendChild(interim);
  }
  interim.textContent = text;
  container.scrollTop = container.scrollHeight;
}

// Stop real-time session
async function stopRealtimeSession() {
  // Stop sending audio
  if (realtimeProcessor) {
    realtimeProcessor.disconnect();
    realtimeProcessor = null;
  }
  if (realtimeAudioContext) {
    realtimeAudioContext.close();
    realtimeAudioContext = null;
  }

  // Signal end of audio to Deepgram
  if (realtimeSocket?.readyState === WebSocket.OPEN) {
    realtimeSocket.send(new ArrayBuffer(0));
    // Wait briefly for final results
    await new Promise(resolve => setTimeout(resolve, 1500));
    realtimeSocket.close();
  }
  realtimeSocket = null;

  // Assemble final result from accumulated segments
  if (realtimeSegments.length > 0) {
    const fullText = realtimeSegments.map(s => s.text).join(' ');
    currentResult = {
      full_text: fullText,
      segments: realtimeSegments.map(s => ({
        timestamp: formatTime(Math.floor(s.start)),
        text: s.text
      }))
    };

    currentMetadata = {
      source: 'Tab Recording (Real-time)',
      source_type: 'recording',
      extraction_method: 'cloud',
      duration_seconds: recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : null,
      processed_at: new Date().toISOString()
    };

    await chrome.storage.local.set({
      transcriptResult: currentResult,
      transcriptMetadata: currentMetadata
    });

    showResult(currentResult);
    incrementUsage();
    trySyncOrQueue(currentResult, currentMetadata);
  }

  document.getElementById('realtimeTranscript').style.display = 'none';
  realtimeSegments = [];
}

// Format seconds to MM:SS
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

// Stop recording
function stopRecording() {
  if (isRealtimeMode) {
    // Stop MediaRecorder first
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    // Then stop the realtime WebSocket session
    stopRealtimeSession();
  } else {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }

  clearInterval(recordingTimer);

  document.getElementById('startRecordBtn').style.display = 'block';
  document.getElementById('stopRecordBtn').style.display = 'none';
  document.getElementById('recordingIndicator').classList.remove('active');

  isRealtimeMode = false;
}

// Transcribe recording via cloud (Deepgram Nova-2)
async function transcribeRecording(blob) {
  if (!await checkUsageLimit()) return;

  const authenticated = await isCloudAuthenticated();
  if (!authenticated) {
    showError('Please sign in to use cloud transcription. <a href="options.html" target="_blank" style="color:#0080FF;text-decoration:underline;">Open Settings to sign in</a>', true);
    return;
  }

  hideError();
  showProgress('Uploading recording...');

  const recordingDuration = recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : null;

  currentMetadata = {
    source: 'Tab Recording',
    source_type: 'recording',
    extraction_method: 'cloud',
    duration_seconds: recordingDuration,
    processed_at: new Date().toISOString()
  };

  try {
    const file = new File([blob], 'recording.webm', { type: 'audio/webm' });
    const result = await transcriptionService.transcribeFile(file, (progress) => {
      updateProgress(progress);
    });

    hideProgress();
    currentResult = result;

    if (result.language) currentMetadata.language = result.language;

    await chrome.storage.local.set({
      transcriptResult: currentResult,
      transcriptMetadata: currentMetadata
    });

    showResult(currentResult);
    incrementUsage();
    trySyncOrQueue(currentResult, currentMetadata);
  } catch (e) {
    hideProgress();
    showError(`Transcription failed: ${e.message}`);
  }
}

// UI helpers
function showError(message, isHtml = false) {
  if (isHtml) {
    errorMessage.innerHTML = message;
  } else {
    errorMessage.textContent = message;
  }
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
      'uploading': '⬆️ Uploading',
      'transcribing': '🎤 Transcribing',
      'processing': '⏳ Processing',
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

  // Generate personalized completion message
  let displayName = 'Transcription';
  if (currentMetadata?.title) {
    displayName = currentMetadata.title.length > 40
      ? currentMetadata.title.substring(0, 37) + '...'
      : currentMetadata.title;
  } else if (currentMetadata?.source) {
    displayName = currentMetadata.source.length > 40
      ? currentMetadata.source.substring(0, 37) + '...'
      : currentMetadata.source;
  }

  // Add speaker info to completion message
  let statusSuffix = '';
  if (result.speakers?.length > 0) {
    statusSuffix = ` (${result.speakers.length} speaker${result.speakers.length > 1 ? 's' : ''})`;
  }

  // Update the result message with dynamic text
  const resultMessage = document.getElementById('resultMessage');
  if (resultMessage) {
    resultMessage.textContent = `${displayName} transcribed${statusSuffix}`;
  }

  // Save transcript data to storage for the transcript page
  await chrome.storage.local.set({
    transcriptResult: result,
    transcriptMetadata: currentMetadata
  });
}

// Hide result section (used when errors occur to prevent showing stale data)
function hideResult() {
  resultSection.classList.remove('active');
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

    // Try to fetch real title via oEmbed
    await fetchVideoTitle(tab.url);

    // Fallback to tab title if oEmbed didn't return a title
    if (!detectedVideoTitle && tab.title) {
      showVideoTitle(tab.title);
    }
  } catch (e) {
    // Silently fail if we can't get the tab URL
  }
}

// Setup URL input listener for title preview
function setupUrlTitlePreview() {
  const urlInput = document.getElementById('urlInput');
  let debounceTimer;

  urlInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    const url = e.target.value.trim();
    detectedVideoTitle = null;

    // Hide title if URL is cleared
    if (!url) {
      hideVideoTitle();
      return;
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return; // Invalid URL, don't fetch
    }

    // Debounce: fetch real title via oEmbed
    debounceTimer = setTimeout(() => {
      fetchVideoTitle(url);
    }, DEBOUNCE_DELAY_MS);
  });
}

// Fetch video/media title via oEmbed (YouTube, Vimeo, SoundCloud, etc.)
async function fetchVideoTitle(url) {
  try {
    const response = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
    if (response.ok) {
      const data = await response.json();
      if (data.title) {
        detectedVideoTitle = data.title;
        showVideoTitle(data.title);
        return;
      }
    }
  } catch (e) {
    // oEmbed failed, fall back to hostname
  }

  // Fallback: show hostname
  try {
    const urlObj = new URL(url);
    showVideoTitle(urlObj.hostname);
  } catch {
    hideVideoTitle();
  }
}

// Show video title above URL input
function showVideoTitle(title) {
  const display = document.getElementById('videoTitleDisplay');
  const titleEl = document.getElementById('videoTitle');

  // Truncate long titles
  const displayTitle = title.length > 70 ? title.substring(0, 67) + '...' : title;
  titleEl.textContent = displayTitle;
  display.style.display = 'block';
}

// Hide video title display
function hideVideoTitle() {
  document.getElementById('videoTitleDisplay').style.display = 'none';
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
      } else if (knownUpdate) {
        // Installed version caught up — clear stale cache
        localStorage.removeItem('availableUpdate');
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

// Show/hide library link based on cloud auth state
async function updateLibraryLink() {
  const link = document.getElementById('libraryLink');
  if (!link) return;
  try {
    const authenticated = await isCloudAuthenticated();
    link.style.display = authenticated ? 'block' : 'none';
  } catch (e) {
    link.style.display = 'none';
  }
}

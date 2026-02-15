// Voxly - Side Panel Script

// ExtensionPay for premium subscriptions
const extpay = ExtPay('voxly'); // TODO: Replace with your ExtensionPay extension ID

// State
let selectedFile = null;
let recordingStartTime = null;
let recordingTimer = null;
let currentResult = null; // Store the result for export
let currentMetadata = null; // Store metadata for enriched exports
let isRealtimeMode = false;
let detectedVideoTitle = null;
let realtimeSegments = [];

// Recording state (getDisplayMedia capture runs directly in side panel)
const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';
let recordingStream = null;
let recordingSocket = null;
let recordingMediaRecorder = null;

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
  // Set up UI immediately — don't block on network calls
  setupTabs();
  setupFileUpload();
  setupButtons();
  setupUpgradeModal();
  setupUrlTitlePreview();

  // Auth and network checks run in parallel — UI is already functional
  checkCloudStatusAndUpdateUI();
  autoPopulateUrl();
  updateUsageIndicator();
  checkForUpdates();
  updateLibraryLink(); // Show library link if cloud user

  // Listen for auth state changes broadcast from options page or background
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'cloudAuthStateChanged') {
      checkCloudStatusAndUpdateUI();
      updateLibraryLink();
      updateUsageIndicator();
    }
    // Real-time transcript updates from offscreen document
    if (request.target === 'sidepanel' && request.action === 'realtimeSegment') {
      realtimeSegments = request.allSegments;
      updateRealtimeTranscript(realtimeSegments);
    }
    if (request.target === 'sidepanel' && request.action === 'realtimeInterim') {
      updateRealtimeTranscriptInterim(request.text);
    }
    if (request.target === 'sidepanel' && request.action === 'captureError') {
      showError(`Recording failed: ${request.error}`);
    }
  });

  // Retry auth check — Supabase async storage adapter may not be ready yet
  setTimeout(async () => {
    if (statusBar.classList.contains('disconnected')) {
      await checkCloudStatusAndUpdateUI();
      updateLibraryLink();
    }
  }, 1500);

  // Update detected title when user navigates to a different page.
  // Must check both changeInfo.url (SPA navigation like YouTube) and
  // changeInfo.status === 'complete' (full page loads).
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
      autoPopulateUrl();
    }
  });

  // Update detected title when user switches to a different browser tab
  chrome.tabs.onActivated.addListener(() => {
    autoPopulateUrl();
  });
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
    // Timeout after 5s to prevent hanging forever if Supabase is unreachable
    const authenticated = await Promise.race([
      isCloudAuthenticated(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Auth check timed out')), 5000))
    ]);
    if (authenticated) {
      statusBar.className = 'status-bar connected';
      statusText.textContent = 'Cloud ready';
    } else {
      statusBar.className = 'status-bar disconnected';
      statusText.innerHTML = signInLink;
    }
    return authenticated;
  } catch (e) {
    console.log('[Voxly] Cloud status check failed:', e.message);
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
    // Validate URL format
    try {
      new URL(url);
    } catch {
      showError('Please enter a valid URL');
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
    if (result.duration) {
      currentMetadata.duration_seconds = result.duration;
      currentMetadata.duration_display = formatDuration(result.duration);
    }

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
    if (e.message.includes('quota exceeded')) {
      showUpgradeModal();
    } else {
      showError(`Transcription failed: ${e.message}`);
    }
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
    if (result.duration) {
      currentMetadata.duration_seconds = result.duration;
      currentMetadata.duration_display = formatDuration(result.duration);
    }

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
    if (e.message.includes('quota exceeded')) {
      showUpgradeModal();
    } else if (e.message.includes('invalid-request') || e.message.includes('could not be detected') || e.message.includes('Supadata error')) {
      const urlValue = document.getElementById('urlInput').value.trim();
      if (urlValue.includes('drive.google.com') || urlValue.includes('docs.google.com')) {
        showError('Google Drive links cannot be transcribed directly. Download the file first, then use the Upload tab.');
      } else if (urlValue.includes('meet.google.com')) {
        showError('Google Meet links cannot be transcribed. To capture a meeting, use the Record tab while the meeting is active.');
      } else if (urlValue.includes('podcasts.apple.com') || urlValue.includes('spotify.com') || urlValue.includes('music.amazon')) {
        showError('Podcast platform links are not yet supported. Try pasting the direct episode URL from the podcast\'s website, or use the Upload tab with a downloaded episode.');
      } else {
        showError('This URL could not be transcribed. Supported: YouTube, TikTok, Instagram, X, Facebook, and other public video/audio URLs. For local files, use the Upload tab.');
      }
    } else {
      showError(`Transcription failed: ${e.message}`);
    }
  }
}

// Start recording from microphone and stream to Deepgram for real-time transcription.
// Uses getUserMedia (microphone) — simple, reliable, no special Chrome permissions.
// Captures your voice + whatever comes through speakers (good for meetings).
async function startRecording() {
  isRealtimeMode = true;

  try {
    // Get the active tab for naming the recording
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log('[Voxly] Starting mic recording for tab:', activeTab?.title?.substring(0, 50));

    // Get temporary Deepgram key
    const { key } = await transcriptionService.getRealtimeToken();
    console.log('[Voxly] Got realtime token');

    // Capture microphone audio
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioTracks = recordingStream.getAudioTracks();
    console.log(`[Voxly] Got mic stream — ${audioTracks.length} audio tracks, device: ${audioTracks[0]?.label}`);

    // Connect to Deepgram WebSocket
    const wsUrl = `${DEEPGRAM_WS_URL}?model=nova-2&interim_results=true&diarize=true`;
    recordingSocket = new WebSocket(wsUrl, ['token', key]);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Deepgram WebSocket timed out')), 10000);
      recordingSocket.onopen = () => {
        clearTimeout(timeout);
        console.log('[Voxly] Deepgram WebSocket connected');
        resolve();
      };
      recordingSocket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Deepgram WebSocket connection failed'));
      };
    });

    // Handle Deepgram responses
    recordingSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'Results') {
        const transcript = data.channel?.alternatives?.[0]?.transcript || '';
        if (transcript && data.is_final) {
          const segment = {
            text: transcript,
            start: data.start,
            end: data.start + data.duration
          };
          realtimeSegments.push(segment);
          updateRealtimeTranscript(realtimeSegments);
        } else if (transcript) {
          updateRealtimeTranscriptInterim(transcript);
        }
      }
    };

    recordingSocket.onerror = () => console.log('[Voxly] Deepgram WebSocket error');
    recordingSocket.onclose = (event) => console.log(`[Voxly] Deepgram WebSocket closed — code=${event.code}`);

    // MediaRecorder sends WebM/Opus chunks to Deepgram every 250ms
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    recordingMediaRecorder = new MediaRecorder(recordingStream, { mimeType });

    let chunkCount = 0;
    recordingMediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0 && recordingSocket?.readyState === WebSocket.OPEN) {
        const buffer = await event.data.arrayBuffer();
        recordingSocket.send(buffer);
        if (chunkCount < 5 || chunkCount % 20 === 0) {
          console.log(`[Voxly] Chunk ${chunkCount}: ${buffer.byteLength} bytes`);
        }
        chunkCount++;
      }
    };

    recordingMediaRecorder.start(250);
    console.log('[Voxly] MediaRecorder started — streaming mic audio to Deepgram');

    realtimeSegments = [];
    recordingStartTime = Date.now();

    // Update UI
    document.getElementById('startRecordBtn').style.display = 'none';
    document.getElementById('stopRecordBtn').style.display = 'block';
    document.getElementById('recordingIndicator').classList.add('active');

    document.getElementById('realtimeTranscript').style.display = 'block';
    document.getElementById('realtimeTranscript').innerHTML = '<em style="color: #999;">Listening via microphone...</em>';

    // Start timer
    recordingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const secs = (elapsed % 60).toString().padStart(2, '0');
      document.getElementById('recordingTime').textContent = `${mins}:${secs}`;
    }, 1000);

  } catch (e) {
    // Clean up on failure
    if (recordingStream) {
      recordingStream.getTracks().forEach(t => t.stop());
      recordingStream = null;
    }
    if (recordingSocket) {
      recordingSocket.close();
      recordingSocket = null;
    }
    recordingMediaRecorder = null;
    isRealtimeMode = false;

    if (e.name === 'NotAllowedError' || e.message.includes('Permission denied')) {
      showError('Microphone access denied. Allow microphone permission and try again.');
    } else {
      showError(`Recording failed: ${e.message}`);
    }
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

// Process final recording results from offscreen document
async function processFinalRecording(finalSegments) {
  // Merge any segments received via stopCapture response
  if (finalSegments?.length > 0) {
    realtimeSegments = finalSegments;
  }

  console.log(`[Voxly] Recording stopped — ${realtimeSegments.length} segments captured`);

  if (realtimeSegments.length === 0) {
    showError('No speech detected during recording. Make sure the tab is playing audio and try again.');
  }

  if (realtimeSegments.length > 0) {
    const fullText = realtimeSegments.map(s => s.text).join(' ');
    currentResult = {
      full_text: fullText,
      segments: realtimeSegments.map(s => ({
        timestamp: formatTime(Math.floor(s.start)),
        text: s.text,
        start: s.start,
        end: s.end
      })),
      speakers: [],
      diarization_status: 'skipped'
    };

    // Capture tab title for the recording name
    let recordingTitle = 'Tab Recording';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.title) {
        recordingTitle = tab.title.replace(/\s*[-–—]\s*Google Chrome$/, '').trim() || 'Tab Recording';
      }
    } catch (_e) { /* fall back to default */ }

    const rtDuration = recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : null;
    currentMetadata = {
      title: recordingTitle,
      source: 'Tab Recording (Real-time)',
      source_type: 'recording',
      extraction_method: 'cloud',
      duration_seconds: rtDuration,
      duration_display: rtDuration ? formatDuration(rtDuration) : null,
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
async function stopRecording() {
  clearInterval(recordingTimer);

  document.getElementById('startRecordBtn').style.display = 'block';
  document.getElementById('stopRecordBtn').style.display = 'none';
  document.getElementById('recordingIndicator').classList.remove('active');

  // Stop MediaRecorder
  if (recordingMediaRecorder && recordingMediaRecorder.state !== 'inactive') {
    recordingMediaRecorder.stop();
    await new Promise(resolve => setTimeout(resolve, 500)); // Wait for final chunk
  }
  recordingMediaRecorder = null;

  // Stop all tracks
  if (recordingStream) {
    recordingStream.getTracks().forEach(t => t.stop());
    recordingStream = null;
  }

  // Close Deepgram WebSocket and wait for final results
  if (recordingSocket?.readyState === WebSocket.OPEN) {
    recordingSocket.send(new ArrayBuffer(0)); // Close signal
    await new Promise(resolve => setTimeout(resolve, 1500));
    recordingSocket.close();
  }
  recordingSocket = null;

  console.log(`[Voxly] Recording stopped — ${realtimeSegments.length} segments captured`);
  await processFinalRecording(realtimeSegments.length > 0 ? realtimeSegments : null);

  isRealtimeMode = false;
}

// Transcribe recording via cloud (Deepgram Nova-2)
// Format seconds into human-readable duration (e.g. "5:23" or "1:02:15")
function formatDuration(seconds) {
  const s = Math.round(seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
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
// Patterns for live meeting/streaming sites where Record tab is more appropriate
const LIVE_RECORDING_SITES = [
  'meet.google.com',
  'zoom.us',
  'teams.microsoft.com',
  'teams.live.com',
  'webex.com',
  'discord.com/channels',
  'slack.com/huddle',
  'whereby.com',
  'around.co',
  'gather.town',
  'twitch.tv'
];

async function autoPopulateUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;

    // Skip chrome:// and other internal URLs
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://')) {
      hideVideoTitle();
      return;
    }

    // Auto-switch to Record tab for live meeting/streaming sites
    const isLiveSite = LIVE_RECORDING_SITES.some(site => tab.url.includes(site));
    if (isLiveSite) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.querySelector('.tab[data-tab="record"]').classList.add('active');
      document.getElementById('tab-record').classList.add('active');
    }

    // Always populate the URL field with the current tab
    document.getElementById('urlInput').value = tab.url;

    // Show tab title immediately as preview while oEmbed loads
    if (tab.title) {
      detectedVideoTitle = tab.title;
      showVideoTitle(tab.title);
    }

    // Try to fetch real title via oEmbed (overrides tab title if found)
    await fetchVideoTitle(tab.url);
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

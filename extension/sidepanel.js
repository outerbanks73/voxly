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
let realtimeMicStream = null;
let realtimeDisplayStream = null; // Original getDisplayMedia stream (keeps video tracks alive)

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

// Obtain an audio stream from the current tab.
// Tries chrome.tabCapture first (seamless), falls back to getDisplayMedia (shows picker).
async function getTabAudioStream() {
  // Get the active tab for targeted capture
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Method 1: chrome.tabCapture with explicit targetTabId
  if (activeTab?.id && !activeTab.url?.startsWith('chrome://') && !activeTab.url?.startsWith('chrome-extension://')) {
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        }
      });
      console.log('[Voxly] Tab capture succeeded (tabCapture API, tab:', activeTab.title?.substring(0, 40), ')');
      return stream;
    } catch (e) {
      console.log('[Voxly] tabCapture failed, trying getDisplayMedia:', e.message);
    }
  } else {
    console.log('[Voxly] Active tab is chrome page, skipping tabCapture');
  }

  // Method 2: getDisplayMedia — always works, shows Chrome's share dialog
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true,
    preferCurrentTab: true
  });

  // IMPORTANT: Do NOT stop video tracks — Chrome may kill audio capture if
  // video tracks are stopped from a getDisplayMedia session. Instead, extract
  // only the audio tracks into a new stream for our use.
  const audioTracks = stream.getAudioTracks();

  if (audioTracks.length === 0) {
    stream.getTracks().forEach(track => track.stop());
    throw new Error('No audio captured. Make sure "Also share tab audio" is checked in the share dialog.');
  }

  // Keep reference to original stream so video tracks stay alive during recording
  // (stopping video tracks can kill Chrome's capture session and silence audio)
  realtimeDisplayStream = stream;

  // Return audio-only stream for processing
  const audioStream = new MediaStream(audioTracks);
  console.log('[Voxly] Tab capture succeeded (getDisplayMedia fallback, audio tracks:', audioTracks.length, 'video tracks kept alive:', stream.getVideoTracks().length, ')');
  return audioStream;
}

// Start recording tab audio
async function startRecording() {
  isRealtimeMode = true;

  try {
    const tabStream = await getTabAudioStream();

    // Request microphone for mixed recording (tab + mic)
    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('[Voxly] Microphone access granted — recording tab + mic audio');
    } catch (micErr) {
      console.warn('[Voxly] Microphone access denied — recording tab audio only:', micErr.message);
    }

    recordedChunks = [];

    // Real-time mode: stream to Deepgram WebSocket
    try {
      await startRealtimeSession(tabStream, micStream);
    } catch (sessionErr) {
      // Clean up streams if session fails
      tabStream.getTracks().forEach(t => t.stop());
      if (micStream) micStream.getTracks().forEach(t => t.stop());
      throw new Error(`Real-time session failed: ${sessionErr.message}`);
    }

    recordingStartTime = Date.now();

    // Update UI
    document.getElementById('startRecordBtn').style.display = 'none';
    document.getElementById('stopRecordBtn').style.display = 'block';
    document.getElementById('recordingIndicator').classList.add('active');

    document.getElementById('realtimeTranscript').style.display = 'block';
    document.getElementById('realtimeTranscript').innerHTML = '<em style="color: #999;">Listening...</em>';

    // Start timer
    recordingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const secs = (elapsed % 60).toString().padStart(2, '0');
      document.getElementById('recordingTime').textContent = `${mins}:${secs}`;
    }, 1000);

  } catch (e) {
    if (e.message.includes('Permission denied') || e.message.includes('cancelled') || e.message.includes('AbortError')) {
      showError('Recording cancelled. Click Start Recording and select the tab to share.');
    } else {
      showError(`Recording failed: ${e.message}`);
    }
  }
}

// Start real-time transcription session via Deepgram WebSocket
async function startRealtimeSession(tabStream, micStream) {
  // Get temporary Deepgram key from Edge Function
  const { key } = await transcriptionService.getRealtimeToken();
  console.log('[Voxly] Got realtime token');

  // Create AudioContext at default sample rate (avoids Chrome resampling issues)
  realtimeAudioContext = new AudioContext();
  if (realtimeAudioContext.state === 'suspended') {
    console.log('[Voxly] AudioContext suspended, resuming...');
    await realtimeAudioContext.resume();
  }
  const sampleRate = realtimeAudioContext.sampleRate;
  console.log('[Voxly] AudioContext state:', realtimeAudioContext.state, 'sampleRate:', sampleRate);

  // Open WebSocket to Deepgram with actual sample rate
  const wsUrl = `${DEEPGRAM_WS_URL}?model=nova-2&interim_results=true&diarize=true&encoding=linear16&sample_rate=${sampleRate}`;
  realtimeSocket = new WebSocket(wsUrl, ['token', key]);

  realtimeSegments = [];

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Deepgram WebSocket connection timed out')), 10000);
    realtimeSocket.onopen = () => {
      clearTimeout(timeout);
      console.log('[Voxly] Deepgram WebSocket connected');
      resolve();
    };
    realtimeSocket.onerror = (e) => {
      clearTimeout(timeout);
      console.error('[Voxly] Deepgram WebSocket error:', e);
      reject(new Error('Deepgram WebSocket connection failed'));
    };
  });

  realtimeSocket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log(`[Voxly] Deepgram message: type=${data.type}`, data.type !== 'Results' ? JSON.stringify(data).substring(0, 200) : '');
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

  realtimeSocket.onclose = (event) => {
    console.log(`[Voxly] Deepgram WebSocket closed — code: ${event.code}, reason: "${event.reason}"`);
  };

  // Mix tab audio + microphone via a GainNode bus
  const mixer = realtimeAudioContext.createGain();
  mixer.gain.value = 1.0;

  const tabSource = realtimeAudioContext.createMediaStreamSource(tabStream);
  tabSource.connect(mixer);

  if (micStream) {
    realtimeMicStream = micStream;
    const micSource = realtimeAudioContext.createMediaStreamSource(micStream);
    micSource.connect(mixer);
  }

  // ScriptProcessor reads the mixed signal and sends PCM to Deepgram
  realtimeProcessor = realtimeAudioContext.createScriptProcessor(4096, 1, 1);

  let audioFramesSent = 0;
  realtimeProcessor.onaudioprocess = (e) => {
    if (realtimeSocket?.readyState === WebSocket.OPEN) {
      const float32 = e.inputBuffer.getChannelData(0);

      // Monitor audio levels (first 10 frames + every 100th)
      if (audioFramesSent < 10 || audioFramesSent % 100 === 0) {
        let maxAmp = 0;
        for (let i = 0; i < float32.length; i++) {
          const abs = Math.abs(float32[i]);
          if (abs > maxAmp) maxAmp = abs;
        }
        console.log(`[Voxly] Audio frame ${audioFramesSent}: maxAmplitude=${maxAmp.toFixed(6)}${maxAmp < 0.001 ? ' ⚠️ SILENCE' : ''}`);
      }

      // Convert float32 to int16 PCM
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      realtimeSocket.send(int16.buffer);
      audioFramesSent++;
      if (audioFramesSent === 1) {
        console.log('[Voxly] First audio frame sent to Deepgram');
      } else if (audioFramesSent % 100 === 0) {
        console.log(`[Voxly] Audio frames sent: ${audioFramesSent}`);
      }
    }
  };

  mixer.connect(realtimeProcessor);
  realtimeProcessor.connect(realtimeAudioContext.destination);

  // Record the mixed stream for archival
  const mixedDest = realtimeAudioContext.createMediaStreamDestination();
  mixer.connect(mixedDest);
  mediaRecorder = new MediaRecorder(mixedDest.stream, { mimeType: 'audio/webm' });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.start(1000);
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
  if (realtimeMicStream) {
    realtimeMicStream.getTracks().forEach(track => track.stop());
    realtimeMicStream = null;
  }
  // Clean up the original getDisplayMedia stream (video tracks kept alive during recording)
  if (realtimeDisplayStream) {
    realtimeDisplayStream.getTracks().forEach(track => track.stop());
    realtimeDisplayStream = null;
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
        // Clean up common suffixes like " - Google Chrome"
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
  // Stop MediaRecorder first
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  // Then stop the realtime WebSocket session (must await for results to save)
  await stopRealtimeSession();

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
    duration_display: recordingDuration ? formatDuration(recordingDuration) : null,
    processed_at: new Date().toISOString()
  };

  try {
    // Use the blob's actual MIME type (may be audio/webm, video/webm, etc.)
    const blobType = blob.type || 'audio/webm';
    const ext = blobType.includes('webm') ? 'webm' : blobType.includes('ogg') ? 'ogg' : 'webm';
    const file = new File([blob], `recording.${ext}`, { type: blobType });
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
    if (e.message.includes('quota exceeded')) {
      showUpgradeModal();
    } else {
      showError(`Transcription failed: ${e.message}`);
    }
  }
}

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
async function autoPopulateUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;

    // Skip chrome:// and other internal URLs
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://')) {
      hideVideoTitle();
      return;
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

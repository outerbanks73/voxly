// SpeakToText Local - Popup Script

const SERVER_URL = 'http://localhost:5123';

// State
let currentJobId = null;
let pollInterval = null;
let selectedFile = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = null;
let recordingTimer = null;

// DOM Elements
const statusBar = document.getElementById('statusBar');
const statusText = document.getElementById('statusText');
const errorMessage = document.getElementById('errorMessage');
const progressSection = document.getElementById('progressSection');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const resultSection = document.getElementById('resultSection');
const transcriptBox = document.getElementById('transcriptBox');

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await checkServerConnection();
  setupTabs();
  setupFileUpload();
  setupButtons();
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
    fileDropZone.style.borderColor = '#667eea';
  });

  fileDropZone.addEventListener('dragleave', () => {
    fileDropZone.style.borderColor = '#ccc';
  });

  fileDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    fileDropZone.style.borderColor = '#ccc';
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

  // Result actions
  document.getElementById('copyBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(transcriptBox.textContent);
    document.getElementById('copyBtn').textContent = 'Copied!';
    setTimeout(() => {
      document.getElementById('copyBtn').textContent = 'Copy';
    }, 2000);
  });

  document.getElementById('downloadBtn').addEventListener('click', () => {
    const blob = new Blob([transcriptBox.textContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'transcript.txt';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    resultSection.classList.remove('active');
    transcriptBox.textContent = '';
    currentJobId = null;
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

// Transcribe file
async function transcribeFile(file) {
  const connected = await checkServerConnection();
  if (!connected) {
    showError('Server not running. Please start the local server first.');
    return;
  }

  hideError();
  showProgress('Uploading file...');

  const formData = new FormData();
  formData.append('file', file);
  formData.append('model', document.getElementById('modelSelect').value);

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
      pollJobStatus();
    } else {
      showError('Failed to start transcription');
      hideProgress();
    }
  } catch (e) {
    showError(`Error: ${e.message}`);
    hideProgress();
  }
}

// Transcribe URL
async function transcribeUrl(url) {
  const connected = await checkServerConnection();
  if (!connected) {
    showError('Server not running. Please start the local server first.');
    return;
  }

  hideError();
  showProgress('Downloading audio...');

  const formData = new FormData();
  formData.append('url', url);
  formData.append('model', document.getElementById('modelSelectUrl').value);

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
      pollJobStatus();
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
    recordingStartTime = Date.now();

    // Update UI
    document.getElementById('startRecordBtn').style.display = 'none';
    document.getElementById('stopRecordBtn').style.display = 'block';
    document.getElementById('recordingIndicator').classList.add('active');

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

// Stop recording
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  clearInterval(recordingTimer);
  document.getElementById('startRecordBtn').style.display = 'block';
  document.getElementById('stopRecordBtn').style.display = 'none';
  document.getElementById('recordingIndicator').classList.remove('active');
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

  const formData = new FormData();
  formData.append('file', blob, 'recording.webm');
  formData.append('model', document.getElementById('modelSelectRecord').value);

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
      pollJobStatus();
    } else {
      showError('Failed to start transcription');
      hideProgress();
    }
  } catch (e) {
    showError(`Error: ${e.message}`);
    hideProgress();
  }
}

// Poll job status
function pollJobStatus() {
  if (pollInterval) {
    clearInterval(pollInterval);
  }

  pollInterval = setInterval(async () => {
    if (!currentJobId) {
      clearInterval(pollInterval);
      return;
    }

    try {
      const response = await fetch(`${SERVER_URL}/job/${currentJobId}`);
      const job = await response.json();

      if (job.status === 'completed') {
        clearInterval(pollInterval);
        hideProgress();
        showResult(job.result);
      } else if (job.status === 'error') {
        clearInterval(pollInterval);
        hideProgress();
        showError(job.error || 'Transcription failed');
      } else {
        updateProgress(job.progress || 'Processing...');
      }
    } catch (e) {
      // Retry on network error
    }
  }, 1000);
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

function updateProgress(text) {
  progressText.textContent = text;
}

function hideProgress() {
  progressSection.classList.remove('active');
}

function showResult(result) {
  resultSection.classList.add('active');

  if (result.speakers && result.speakers.length > 0) {
    // Format with speakers
    let html = `<strong>Speakers:</strong> ${result.speakers.join(', ')}\n\n`;
    result.segments.forEach(seg => {
      html += `<span class="timestamp">[${seg.timestamp}]</span> <span class="speaker-label">${seg.speaker}:</span>\n${seg.text}\n\n`;
    });
    transcriptBox.innerHTML = html;
  } else {
    // Plain text
    transcriptBox.textContent = result.full_text;
  }
}

// SpeakToText Local - Options Script

const SERVER_URL = 'http://localhost:5123';

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  checkServerStatus();
  setupEventListeners();
});

function loadSettings() {
  chrome.storage.sync.get(['hfToken'], (result) => {
    if (result.hfToken) {
      document.getElementById('hfTokenInput').value = result.hfToken;
    }
  });
}

async function checkServerStatus() {
  const statusEl = document.getElementById('serverStatus');
  const statusText = document.getElementById('serverStatusText');

  try {
    const response = await fetch(`${SERVER_URL}/health`, { method: 'GET' });
    if (response.ok) {
      statusEl.className = 'server-status connected';
      statusText.textContent = 'Connected';
      return true;
    }
  } catch (e) {
    // Connection failed
  }

  statusEl.className = 'server-status disconnected';
  statusText.textContent = 'Not running';
  return false;
}

function setupEventListeners() {
  // Toggle token visibility
  const toggleBtn = document.getElementById('toggleToken');
  const tokenInput = document.getElementById('hfTokenInput');

  toggleBtn.addEventListener('click', () => {
    if (tokenInput.type === 'password') {
      tokenInput.type = 'text';
      toggleBtn.textContent = '🙈';
    } else {
      tokenInput.type = 'password';
      toggleBtn.textContent = '👁️';
    }
  });

  // Save token
  document.getElementById('saveTokenBtn').addEventListener('click', () => {
    const token = tokenInput.value.trim();
    const statusEl = document.getElementById('tokenStatus');

    chrome.storage.sync.set({ hfToken: token }, () => {
      statusEl.className = 'status-message success';
      statusEl.textContent = token ? 'Token saved successfully!' : 'Token cleared.';

      setTimeout(() => {
        statusEl.className = 'status-message';
      }, 3000);
    });
  });

  // Refresh server status
  document.getElementById('checkServerBtn').addEventListener('click', () => {
    document.getElementById('serverStatusText').textContent = 'Checking...';
    checkServerStatus();
  });
}

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
      updateTokenStatus('saved');
    } else {
      updateTokenStatus('empty');
    }
  });
}

function updateTokenStatus(status) {
  const indicator = document.getElementById('tokenStatusIndicator');
  switch (status) {
    case 'saved':
      indicator.className = 'token-status valid';
      indicator.innerHTML = '✅ Token saved';
      break;
    case 'valid':
      indicator.className = 'token-status valid';
      indicator.innerHTML = '✅ Token is valid';
      break;
    case 'invalid':
      indicator.className = 'token-status invalid';
      indicator.innerHTML = '❌ Token is invalid - check the format (should start with hf_)';
      break;
    case 'checking':
      indicator.className = 'token-status checking';
      indicator.innerHTML = '⏳ Checking token...';
      break;
    case 'empty':
      indicator.className = 'token-status';
      indicator.innerHTML = '⚠️ No token set - speaker identification disabled';
      break;
    case 'error':
      indicator.className = 'token-status invalid';
      indicator.innerHTML = '❌ Could not verify token - server may be offline';
      break;
    default:
      indicator.className = 'token-status';
      indicator.innerHTML = '';
  }
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

  // Test token
  document.getElementById('testTokenBtn').addEventListener('click', async () => {
    const token = tokenInput.value.trim();

    if (!token) {
      updateTokenStatus('empty');
      return;
    }

    if (!token.startsWith('hf_')) {
      updateTokenStatus('invalid');
      return;
    }

    updateTokenStatus('checking');

    // Simple format validation
    if (token.length > 10 && token.startsWith('hf_')) {
      // Token format looks valid
      updateTokenStatus('valid');
      const statusEl = document.getElementById('tokenStatus');
      statusEl.className = 'status-message success';
      statusEl.textContent = 'Token format is valid! Make sure you accepted both model licenses on Hugging Face.';
      setTimeout(() => {
        statusEl.className = 'status-message';
      }, 5000);
    } else {
      updateTokenStatus('invalid');
    }
  });
}

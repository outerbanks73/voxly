// Voxly - Options Script
// SERVER_URL and other constants are defined in config.js

// ExtensionPay for premium checks
const extpay = ExtPay('voxly');

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  checkServerStatus();
  setupEventListeners();
  setupCloudAuth();
});

function loadSettings() {
  // Load auth token from local storage
  chrome.storage.local.get(['authToken'], (result) => {
    if (result.authToken) {
      document.getElementById('authTokenInput').value = result.authToken;
    }
  });

  // Migrate keys from sync to local storage (one-time migration)
  chrome.storage.sync.get(['hfToken', 'openaiApiKey'], (syncResult) => {
    if (syncResult.hfToken || syncResult.openaiApiKey) {
      const toMigrate = {};
      if (syncResult.hfToken) toMigrate.hfToken = syncResult.hfToken;
      if (syncResult.openaiApiKey) toMigrate.openaiApiKey = syncResult.openaiApiKey;
      chrome.storage.local.set(toMigrate, () => {
        chrome.storage.sync.remove(['hfToken', 'openaiApiKey']);
        console.log('Migrated API keys from sync to local storage');
      });
    }
  });

  // Load sensitive keys from local storage
  chrome.storage.local.get(['hfToken', 'openaiApiKey'], (result) => {
    if (result.hfToken) {
      document.getElementById('hfTokenInput').value = result.hfToken;
      updateTokenStatus('saved');
    } else {
      updateTokenStatus('empty');
    }

    if (result.openaiApiKey) {
      document.getElementById('openaiKeyInput').value = result.openaiApiKey;
    }
  });

  // Storage folder stays in sync (not sensitive)
  chrome.storage.sync.get(['storageFolder'], (result) => {
    if (result.storageFolder) {
      document.getElementById('storageFolderInput').value = result.storageFolder;
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

  const connected = await checkServerConnection();
  if (connected) {
    statusEl.className = 'server-status connected';
    statusText.textContent = 'Connected';
  } else {
    statusEl.className = 'server-status disconnected';
    statusText.textContent = 'Not running';
  }
  return connected;
}

function setupEventListeners() {
  // Save auth token
  document.getElementById('saveAuthTokenBtn').addEventListener('click', () => {
    const token = document.getElementById('authTokenInput').value.trim();
    const statusEl = document.getElementById('authTokenStatus');

    chrome.storage.local.set({ authToken: token }, () => {
      statusEl.className = 'status-message success';
      statusEl.textContent = token ? 'Auth token saved! Extension will use it for server requests.' : 'Auth token cleared.';

      // Re-check server connection with the new token
      checkServerStatus();

      setTimeout(() => {
        statusEl.className = 'status-message';
      }, STATUS_MESSAGE_TIMEOUT_MS);
    });
  });

  // Toggle auth token visibility
  const toggleAuthBtn = document.getElementById('toggleAuthToken');
  const authTokenInput = document.getElementById('authTokenInput');

  if (toggleAuthBtn && authTokenInput) {
    toggleAuthBtn.addEventListener('click', () => {
      if (authTokenInput.type === 'password') {
        authTokenInput.type = 'text';
        toggleAuthBtn.textContent = '🙈';
      } else {
        authTokenInput.type = 'password';
        toggleAuthBtn.textContent = '👁️';
      }
    });
  }

  // Toggle HF token visibility
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

  // Toggle OpenAI key visibility
  const toggleOpenaiBtn = document.getElementById('toggleOpenaiKey');
  const openaiKeyInput = document.getElementById('openaiKeyInput');

  if (toggleOpenaiBtn && openaiKeyInput) {
    toggleOpenaiBtn.addEventListener('click', () => {
      if (openaiKeyInput.type === 'password') {
        openaiKeyInput.type = 'text';
        toggleOpenaiBtn.textContent = '🙈';
      } else {
        openaiKeyInput.type = 'password';
        toggleOpenaiBtn.textContent = '👁️';
      }
    });
  }

  // Save OpenAI API key
  const saveOpenaiBtn = document.getElementById('saveOpenaiKeyBtn');
  if (saveOpenaiBtn) {
    saveOpenaiBtn.addEventListener('click', () => {
      const key = openaiKeyInput.value.trim();
      const statusEl = document.getElementById('openaiKeyStatus');

      chrome.storage.local.set({ openaiApiKey: key }, () => {
        statusEl.className = 'status-message success';
        statusEl.textContent = key ? 'API key saved successfully!' : 'API key cleared.';

        setTimeout(() => {
          statusEl.className = 'status-message';
        }, STATUS_MESSAGE_TIMEOUT_MS);
      });
    });
  }

  // Save token
  document.getElementById('saveTokenBtn').addEventListener('click', () => {
    const token = tokenInput.value.trim();
    const statusEl = document.getElementById('tokenStatus');

    chrome.storage.local.set({ hfToken: token }, () => {
      statusEl.className = 'status-message success';
      statusEl.textContent = token ? 'Token saved successfully!' : 'Token cleared.';

      setTimeout(() => {
        statusEl.className = 'status-message';
      }, STATUS_MESSAGE_TIMEOUT_MS);
    });
  });

  // Refresh server status
  document.getElementById('checkServerBtn').addEventListener('click', () => {
    document.getElementById('serverStatusText').textContent = 'Checking...';
    checkServerStatus();
  });

  // Test token - actually verify with the server
  document.getElementById('testTokenBtn').addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    const statusEl = document.getElementById('tokenStatus');

    if (!token) {
      updateTokenStatus('empty');
      return;
    }

    if (!token.startsWith('hf_')) {
      updateTokenStatus('invalid');
      return;
    }

    updateTokenStatus('checking');

    try {
      // Call the server's verify-token endpoint
      const formData = new FormData();
      formData.append('hf_token', token);

      const response = await authenticatedFetch(`${SERVER_URL}/verify-token`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error('Server error');
      }

      const result = await response.json();

      if (result.valid) {
        updateTokenStatus('valid');
        statusEl.className = 'status-message success';
        statusEl.textContent = '✅ Token verified! Model access confirmed.';
      } else {
        updateTokenStatus('invalid');
        statusEl.className = 'status-message error';
        statusEl.textContent = `❌ ${result.error || 'Token verification failed'}`;
      }
    } catch (e) {
      // Server may not be running - fall back to format check
      if (token.length > 10 && token.startsWith('hf_')) {
        updateTokenStatus('valid');
        statusEl.className = 'status-message success';
        statusEl.textContent = 'Token format looks valid! Start the server to fully verify model access.';
      } else {
        updateTokenStatus('error');
        statusEl.className = 'status-message error';
        statusEl.textContent = 'Could not verify token - server not running.';
      }
    }

    setTimeout(() => {
      statusEl.className = 'status-message';
    }, 5000);
  });

  // Save storage folder
  document.getElementById('saveStorageBtn').addEventListener('click', async () => {
    const folder = document.getElementById('storageFolderInput').value.trim();
    const statusEl = document.getElementById('storageStatus');

    // Save to extension storage
    chrome.storage.sync.set({ storageFolder: folder }, async () => {
      // Also update the server
      try {
        const response = await authenticatedFetch(`${SERVER_URL}/settings/storage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: folder })
        });

        if (response.ok) {
          statusEl.className = 'status-message success';
          statusEl.textContent = folder ? 'Storage folder saved!' : 'Using system default folder.';
        } else {
          statusEl.className = 'status-message success';
          statusEl.textContent = 'Setting saved. Server will use it on next restart.';
        }
      } catch (e) {
        statusEl.className = 'status-message success';
        statusEl.textContent = 'Setting saved locally. Start server to apply.';
      }

      setTimeout(() => {
        statusEl.className = 'status-message';
      }, STATUS_MESSAGE_TIMEOUT_MS);
    });
  });
}

// ============================================================
// Cloud Account (Supabase Auth)
// ============================================================

async function setupCloudAuth() {
  // Check if user is already signed in
  await updateCloudAuthUI();

  // Listen for auth state changes from other contexts
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'cloudAuthStateChanged') {
      updateCloudAuthUI();
    }
  });

  // Sign in with Google
  document.getElementById('signInGoogleBtn').addEventListener('click', async () => {
    await handleOAuthSignIn('google');
  });

  // Sign in with GitHub
  document.getElementById('signInGitHubBtn').addEventListener('click', async () => {
    await handleOAuthSignIn('github');
  });

  // Sign in with email/password
  document.getElementById('signInEmailBtn').addEventListener('click', async () => {
    await handleEmailSignIn();
  });

  // Sign up with email/password
  document.getElementById('signUpEmailBtn').addEventListener('click', async () => {
    await handleEmailSignUp();
  });

  // Magic link
  document.getElementById('magicLinkBtn').addEventListener('click', async () => {
    await handleMagicLink();
  });

  // Sign out
  document.getElementById('signOutBtn').addEventListener('click', async () => {
    await cloudSignOut();
    await updateCloudAuthUI();
  });
}

async function handleOAuthSignIn(provider) {
  const statusEl = document.getElementById('cloudAuthStatus');
  statusEl.className = 'status-message success';
  statusEl.textContent = 'Opening sign-in window...';

  try {
    await cloudSignInWithOAuth(provider);
    await updateCloudAuthUI();
    statusEl.className = 'status-message';
  } catch (e) {
    statusEl.className = 'status-message error';
    statusEl.textContent = e.message === 'The user did not approve access.'
      ? 'Sign-in cancelled.'
      : `Sign-in failed: ${e.message}`;
    setTimeout(() => { statusEl.className = 'status-message'; }, 5000);
  }
}

async function handleEmailSignIn() {
  const email = document.getElementById('cloudEmailInput').value.trim();
  const password = document.getElementById('cloudPasswordInput').value;
  const statusEl = document.getElementById('cloudAuthStatus');

  if (!email || !password) {
    statusEl.className = 'status-message error';
    statusEl.textContent = 'Please enter email and password.';
    setTimeout(() => { statusEl.className = 'status-message'; }, 3000);
    return;
  }

  try {
    await cloudSignInWithEmail(email, password);
    await updateCloudAuthUI();
  } catch (e) {
    statusEl.className = 'status-message error';
    statusEl.textContent = `Sign-in failed: ${e.message}`;
    setTimeout(() => { statusEl.className = 'status-message'; }, 5000);
  }
}

async function handleEmailSignUp() {
  const email = document.getElementById('cloudEmailInput').value.trim();
  const password = document.getElementById('cloudPasswordInput').value;
  const statusEl = document.getElementById('cloudAuthStatus');

  if (!email || !password) {
    statusEl.className = 'status-message error';
    statusEl.textContent = 'Please enter email and password.';
    setTimeout(() => { statusEl.className = 'status-message'; }, 3000);
    return;
  }

  if (password.length < 6) {
    statusEl.className = 'status-message error';
    statusEl.textContent = 'Password must be at least 6 characters.';
    setTimeout(() => { statusEl.className = 'status-message'; }, 3000);
    return;
  }

  try {
    const data = await cloudSignUpWithEmail(email, password);
    if (data.user && !data.user.confirmed_at) {
      statusEl.className = 'status-message success';
      statusEl.textContent = 'Check your email to confirm your account.';
    } else {
      await updateCloudAuthUI();
    }
  } catch (e) {
    statusEl.className = 'status-message error';
    statusEl.textContent = `Sign-up failed: ${e.message}`;
    setTimeout(() => { statusEl.className = 'status-message'; }, 5000);
  }
}

async function handleMagicLink() {
  const email = document.getElementById('cloudEmailInput').value.trim();
  const statusEl = document.getElementById('cloudAuthStatus');

  if (!email) {
    statusEl.className = 'status-message error';
    statusEl.textContent = 'Please enter your email address.';
    setTimeout(() => { statusEl.className = 'status-message'; }, 3000);
    return;
  }

  try {
    await cloudSignInWithMagicLink(email);
    statusEl.className = 'status-message success';
    statusEl.textContent = 'Magic link sent! Check your email.';
  } catch (e) {
    statusEl.className = 'status-message error';
    statusEl.textContent = `Failed: ${e.message}`;
    setTimeout(() => { statusEl.className = 'status-message'; }, 5000);
  }
}

async function updateCloudAuthUI() {
  const section = document.getElementById('cloudAccountSection');
  const loggedOut = section.querySelector('.logged-out');
  const loggedIn = section.querySelector('.logged-in');

  const user = await getCloudUser();

  if (user) {
    loggedOut.style.display = 'none';
    loggedIn.style.display = 'block';

    const displayName = user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'User';
    const email = user.email || '';
    const avatarUrl = user.user_metadata?.avatar_url;

    document.getElementById('cloudDisplayName').textContent = displayName;
    document.getElementById('cloudEmail').textContent = email;

    const avatarEl = document.getElementById('cloudAvatar');
    if (avatarUrl) {
      avatarEl.innerHTML = `<img src="${avatarUrl}" alt="${displayName}">`;
    } else {
      avatarEl.textContent = displayName.charAt(0).toUpperCase();
    }
  } else {
    loggedOut.style.display = 'block';
    loggedIn.style.display = 'none';
  }
}

// isPremiumUser for cloud feature gating
async function isPremiumUser() {
  try {
    const user = await extpay.getUser();
    return user.paid === true;
  } catch (e) {
    return false;
  }
}

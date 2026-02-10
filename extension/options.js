// Voxly - Options Script

// ExtensionPay for premium checks
const extpay = ExtPay('voxly');

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  setupEventListeners();
  setupCloudAuth();
  setupApiKeys();
});

function loadSettings() {
  // Load OpenAI API key from local storage
  chrome.storage.local.get(['openaiApiKey'], (result) => {
    if (result.openaiApiKey) {
      document.getElementById('openaiKeyInput').value = result.openaiApiKey;
    }
  });
}

function setupEventListeners() {
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

  // Refresh API keys section based on auth state
  setupApiKeys();
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

// ============================================================
// API Key Management
// ============================================================

async function setupApiKeys() {
  const section = document.getElementById('apiKeysSection');
  const user = await getCloudUser();

  // Only show API keys section for logged-in users
  if (!user) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';

  // Create key
  document.getElementById('createApiKeyBtn').addEventListener('click', handleCreateApiKey);

  // Copy new key
  document.getElementById('copyNewKeyBtn').addEventListener('click', async () => {
    const input = document.getElementById('newKeyValue');
    try {
      await navigator.clipboard.writeText(input.value);
      showApiKeyStatus('Key copied to clipboard!', 'success');
    } catch (e) {
      showApiKeyStatus('Failed to copy', 'error');
    }
  });

  // Load existing keys
  await loadApiKeys();
}

async function handleCreateApiKey() {
  const nameInput = document.getElementById('apiKeyNameInput');
  const name = nameInput.value.trim() || 'Default';

  try {
    const result = await createApiKey(name);

    // Show the raw key (only time it's visible)
    const display = document.getElementById('newKeyDisplay');
    const keyInput = document.getElementById('newKeyValue');
    display.style.display = 'block';
    keyInput.value = result.raw_key;

    nameInput.value = '';
    showApiKeyStatus('API key created! Copy it now.', 'success');

    // Reload the list
    await loadApiKeys();
  } catch (e) {
    showApiKeyStatus(`Failed to create key: ${e.message}`, 'error');
  }
}

async function loadApiKeys() {
  const listEl = document.getElementById('apiKeysList');
  listEl.innerHTML = '';

  try {
    const keys = await listApiKeys();

    if (keys.length === 0) {
      listEl.innerHTML = '<p style="font-size: 13px; color: #6b6b6b;">No API keys yet.</p>';
      return;
    }

    keys.forEach(key => {
      const item = document.createElement('div');
      item.className = 'api-key-item';

      const created = new Date(key.created_at).toLocaleDateString();
      const lastUsed = key.last_used ? new Date(key.last_used).toLocaleDateString() : 'Never';

      item.innerHTML = `
        <div class="key-info">
          <span class="key-name">${escapeHtml(key.name)}</span>
          <span class="key-meta"><code>${key.key_prefix}...</code> &middot; Created ${created} &middot; Last used: ${lastUsed}</span>
        </div>
        <button class="btn-revoke" data-key-id="${key.id}">Revoke</button>
      `;

      item.querySelector('.btn-revoke').addEventListener('click', async () => {
        if (confirm(`Revoke API key "${key.name}"? This cannot be undone.`)) {
          try {
            await revokeApiKey(key.id);
            showApiKeyStatus('Key revoked', 'success');
            await loadApiKeys();
          } catch (e) {
            showApiKeyStatus(`Failed: ${e.message}`, 'error');
          }
        }
      });

      listEl.appendChild(item);
    });
  } catch (e) {
    listEl.innerHTML = `<p style="font-size: 13px; color: #dc3545;">Failed to load keys: ${e.message}</p>`;
  }
}

function showApiKeyStatus(message, type) {
  const el = document.getElementById('apiKeyStatus');
  el.className = `status-message ${type}`;
  el.textContent = message;
  setTimeout(() => { el.className = 'status-message'; }, 5000);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

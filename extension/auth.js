// Voxly - Shared Authentication Helper
// Used by background.js, sidepanel.js, options.js, and transcript.js

const AUTH_SERVER_URL = 'http://localhost:5123';

async function getAuthToken() {
  const { authToken } = await chrome.storage.local.get(['authToken']);
  return authToken || '';
}

// Auto-fetch auth token from the server.
// The server only returns the token to chrome-extension:// origins (browser-enforced).
async function autoConfigureAuthToken() {
  try {
    const response = await fetch(`${AUTH_SERVER_URL}/auth/token`);
    if (response.ok) {
      const data = await response.json();
      if (data.token) {
        await chrome.storage.local.set({ authToken: data.token });
        return data.token;
      }
    }
  } catch (e) {
    // Server not available
  }
  return null;
}

async function authenticatedFetch(url, options = {}) {
  let token = await getAuthToken();

  // If no token configured, try auto-configuration
  if (!token) {
    token = await autoConfigureAuthToken();
  }

  if (!options.headers) {
    options.headers = {};
  }
  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, options);

  // On 401, token may be stale — try auto-configuring a fresh one and retry once
  if (response.status === 401) {
    const newToken = await autoConfigureAuthToken();
    if (newToken && newToken !== token) {
      options.headers['Authorization'] = `Bearer ${newToken}`;
      return fetch(url, options);
    }
  }

  return response;
}

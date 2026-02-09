// Voxly - Shared Authentication Helper
// Used by background.js, sidepanel.js, options.js, and transcript.js

async function getAuthToken() {
  const { authToken } = await chrome.storage.local.get(['authToken']);
  return authToken || '';
}

async function authenticatedFetch(url, options = {}) {
  const token = await getAuthToken();
  if (!options.headers) {
    options.headers = {};
  }
  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(url, options);
}

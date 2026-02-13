// Voxly - Background Service Worker
// Handles side panel management, ExtensionPay, and cloud auth

// Shared config
importScripts('config.js');

// Supabase cloud auth + sync
importScripts('lib/supabase.min.js');
importScripts('supabase.js');
importScripts('cloud-auth.js');
importScripts('cloud-sync.js');

// Initialize ExtensionPay for premium subscriptions
importScripts('ExtPay.js');
const extpay = ExtPay('voxly'); // TODO: Replace with your ExtensionPay extension ID
extpay.startBackground();

// isPremiumUser — needed by canUseCloudFeatures() in cloud-auth.js
async function isPremiumUser() {
  try {
    const user = await extpay.getUser();
    return user.paid === true;
  } catch (e) {
    return false;
  }
}

// Listen for extension installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Voxly installed');
    chrome.tabs.create({ url: 'options.html' });
  }

  // Enable side panel to open on action click
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  // Set up cloud session refresh alarm (every 55 min, tokens expire at 60)
  chrome.alarms.create('refreshCloudSession', { periodInMinutes: 55 });

  // Set up cloud sync retry alarm (every 5 min for offline queue)
  chrome.alarms.create('retrySyncQueue', { periodInMinutes: 5 });
});

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// Handle messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getCloudAuthState') {
    getCachedCloudAuthState()
      .then(state => sendResponse({ state }))
      .catch(() => sendResponse({ state: null }));
    return true;
  }

  // Tab capture: get stream ID and start offscreen document
  if (request.action === 'startTabCapture') {
    handleStartTabCapture(request.tabId, request.deepgramKey)
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // Stop tab capture and close offscreen document
  if (request.action === 'stopTabCapture') {
    handleStopTabCapture()
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }
});

// Start tab capture via offscreen document
async function handleStartTabCapture(tabId, deepgramKey) {
  console.log('[Voxly BG] Starting tab capture for tab:', tabId);

  // Get stream ID — from service worker, targetTabId only needs tabCapture permission
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  console.log('[Voxly BG] Got stream ID');

  // Create offscreen document if needed
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Tab audio capture for real-time transcription'
    });
    console.log('[Voxly BG] Created offscreen document');
  }

  // Send capture command to offscreen document
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'startCapture',
    streamId,
    deepgramKey
  });

  if (response?.error) {
    throw new Error(response.error);
  }

  return { ok: true };
}

// Stop tab capture and clean up offscreen document
async function handleStopTabCapture() {
  console.log('[Voxly BG] Stopping tab capture');

  // Send stop command to offscreen document and wait for final segments
  let result = { segments: [] };
  try {
    result = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stopCapture'
    });
  } catch (e) {
    console.warn('[Voxly BG] Stop capture message failed:', e.message);
  }

  // Close offscreen document
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (contexts.length > 0) {
      await chrome.offscreen.closeDocument();
      console.log('[Voxly BG] Closed offscreen document');
    }
  } catch (e) {
    console.warn('[Voxly BG] Close offscreen doc failed:', e.message);
  }

  return result;
}

// Listen to alarms for cloud session refresh and sync retry
chrome.alarms.onAlarm.addListener((alarm) => {
  // Refresh Supabase session to prevent token expiry
  if (alarm.name === 'refreshCloudSession') {
    refreshCloudSession().catch(e => console.log('Cloud session refresh error:', e));
  }

  // Retry pending cloud syncs
  if (alarm.name === 'retrySyncQueue') {
    retryPendingSyncs().catch(e => console.log('Sync retry error:', e));
  }
});

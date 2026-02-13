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

  // Don't auto-open panel on click — we handle it in onClicked to cache stream ID
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

  // Set up cloud session refresh alarm (every 55 min, tokens expire at 60)
  chrome.alarms.create('refreshCloudSession', { periodInMinutes: 55 });

  // Set up cloud sync retry alarm (every 5 min for offline queue)
  chrome.alarms.create('retrySyncQueue', { periodInMinutes: 5 });
});

// When user clicks the extension icon: open side panel AND cache a tab capture
// stream ID while activeTab permission is fresh. The stream ID is used later
// when the user clicks Start Recording.
chrome.action.onClicked.addListener(async (tab) => {
  // Open side panel immediately for responsive UX
  chrome.sidePanel.open({ tabId: tab.id });

  // Cache stream ID while activeTab is fresh (granted by icon click)
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await chrome.storage.local.set({ cachedStreamId: streamId });
    console.log('[Voxly BG] Cached stream ID for tab:', tab.id);
  } catch (e) {
    console.warn('[Voxly BG] Could not cache stream ID:', e.message);
    // Panel still opens — user just won't be able to record this tab
  }
});

// Handle messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getCloudAuthState') {
    getCachedCloudAuthState()
      .then(state => sendResponse({ state }))
      .catch(() => sendResponse({ state: null }));
    return true;
  }

  // Relay logs from offscreen document to SW console
  if (request.action === 'offscreenLog') {
    console.log(request.msg);
    return;
  }

  // Start recording: create offscreen document and begin capture
  if (request.action === 'startTabCapture') {
    handleStartTabCapture(request.deepgramKey)
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

// Start capture using tab capture stream ID.
// Strategy: try fresh getMediaStreamId() first (Chrome 116+ doesn't need activeTab
// without targetTabId). Fall back to cached stream ID from icon click.
async function handleStartTabCapture(deepgramKey) {
  console.log('[Voxly BG] Starting capture via offscreen document');

  let streamId;

  // Try getting a fresh stream ID (Chrome 116+: works without activeTab if no targetTabId)
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({});
    console.log('[Voxly BG] Got fresh stream ID');
  } catch (e) {
    console.warn('[Voxly BG] Fresh stream ID failed:', e.message);
    // Fall back to cached stream ID from when user clicked the icon
    const { cachedStreamId } = await chrome.storage.local.get('cachedStreamId');
    if (cachedStreamId) {
      streamId = cachedStreamId;
      await chrome.storage.local.remove('cachedStreamId');
      console.log('[Voxly BG] Using cached stream ID');
    } else {
      throw new Error('Cannot access tab audio. Click the Voxly icon on the tab you want to record, then try again.');
    }
  }

  // Create offscreen document if needed, and wait for it to load
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length === 0) {
    const readyPromise = new Promise((resolve) => {
      const onReady = (msg) => {
        if (msg.action === 'offscreenReady') {
          chrome.runtime.onMessage.removeListener(onReady);
          resolve();
        }
      };
      chrome.runtime.onMessage.addListener(onReady);
      setTimeout(resolve, 3000); // Fallback timeout
    });

    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Tab audio capture for real-time transcription'
    });
    console.log('[Voxly BG] Created offscreen document, waiting for ready...');
    await readyPromise;
    console.log('[Voxly BG] Offscreen document ready');
  }

  // Send capture command with stream ID
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'startCapture',
    streamId,
    deepgramKey
  });

  console.log('[Voxly BG] Offscreen response:', JSON.stringify(response));

  if (!response) {
    throw new Error('Offscreen document did not respond. Please try again.');
  }
  if (response.error) {
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

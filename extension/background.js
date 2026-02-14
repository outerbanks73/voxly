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

  // Don't auto-open panel on click — we handle it in onClicked to capture tab stream
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

  // Set up cloud session refresh alarm (every 55 min, tokens expire at 60)
  chrome.alarms.create('refreshCloudSession', { periodInMinutes: 55 });

  // Set up cloud sync retry alarm (every 5 min for offline queue)
  chrome.alarms.create('retrySyncQueue', { periodInMinutes: 5 });
});

// When user clicks the extension icon:
// 1. Open side panel
// 2. Create offscreen document (if needed)
// 3. Get stream ID while activeTab is fresh
// 4. Immediately send stream ID to offscreen doc to capture (no caching — IDs expire)
// This matches Chrome's official tabcapture-recorder sample pattern.
chrome.action.onClicked.addListener(async (tab) => {
  // Open side panel immediately for responsive UX
  chrome.sidePanel.open({ tabId: tab.id });

  // Ensure offscreen document exists and is ready
  try {
    let existingContexts = await chrome.runtime.getContexts({
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
      await readyPromise;
      console.log('[Voxly BG] Offscreen document ready');
    }
  } catch (e) {
    console.warn('[Voxly BG] Offscreen doc setup failed:', e.message);
  }

  // Get stream ID and immediately send to offscreen for capture.
  // Stream IDs can expire in seconds — never cache for later use.
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    console.log('[Voxly BG] Got stream ID, sending to offscreen for immediate capture');

    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'captureTab',
      streamId
    });

    if (response?.error) {
      console.error('[Voxly BG] Tab capture failed:', response.error);
    } else {
      console.log('[Voxly BG] Tab captured successfully for tab:', tab.id);
    }
  } catch (e) {
    console.warn('[Voxly BG] Could not capture tab:', e.message);
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

  // Start recording: tell offscreen document to connect to Deepgram and start MediaRecorder
  if (request.action === 'startTabCapture') {
    handleStartRecording(request.deepgramKey)
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // Stop recording and close offscreen document
  if (request.action === 'stopTabCapture') {
    handleStopRecording()
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }
});

// Start recording — offscreen doc already has the tab stream captured
async function handleStartRecording(deepgramKey) {
  console.log('[Voxly BG] Starting recording');

  // Verify offscreen document exists (should have been created on icon click)
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length === 0) {
    throw new Error('No tab captured. Click the Voxly icon on the tab you want to record, then try again.');
  }

  // Tell offscreen to start streaming to Deepgram
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'startRecording',
    deepgramKey
  });

  console.log('[Voxly BG] startRecording response:', JSON.stringify(response));

  if (!response) {
    throw new Error('Offscreen document did not respond. Please try again.');
  }
  if (response.error) {
    throw new Error(response.error);
  }

  return { ok: true };
}

// Stop recording and clean up offscreen document
async function handleStopRecording() {
  console.log('[Voxly BG] Stopping recording');

  // Send stop command to offscreen document and wait for final segments
  let result = { segments: [] };
  try {
    result = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'stopRecording'
    });
  } catch (e) {
    console.warn('[Voxly BG] Stop recording message failed:', e.message);
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

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

  // Don't auto-open panel on click — we handle it in onClicked
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

  // Set up cloud session refresh alarm (every 55 min, tokens expire at 60)
  chrome.alarms.create('refreshCloudSession', { periodInMinutes: 55 });

  // Set up cloud sync retry alarm (every 5 min for offline queue)
  chrome.alarms.create('retrySyncQueue', { periodInMinutes: 5 });
});

// When user clicks the extension icon: open side panel
chrome.action.onClicked.addListener(async (tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Handle messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getCloudAuthState') {
    getCachedCloudAuthState()
      .then(state => sendResponse({ state }))
      .catch(() => sendResponse({ state: null }));
    return true;
  }
});

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

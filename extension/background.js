// Voxly - Background Service Worker
// Handles persistent job tracking, side panel management, ExtensionPay, and cloud auth

// Shared config and auth
importScripts('config.js');
importScripts('auth.js');

// Supabase cloud auth + sync
importScripts('lib/supabase.min.js');
importScripts('supabase.js');
importScripts('cloud-auth.js');
importScripts('cloud-sync.js');

// Initialize ExtensionPay for premium subscriptions
importScripts('ExtPay.js');
const extpay = ExtPay('voxly'); // TODO: Replace with your ExtensionPay extension ID
extpay.startBackground();

// SERVER_URL is defined in config.js

// isPremiumUser — needed by canUseCloudFeatures() in cloud-auth.js
async function isPremiumUser() {
  try {
    const user = await extpay.getUser();
    return user.paid === true;
  } catch (e) {
    return false;
  }
}

// Active job state
let activeJob = null; // { id, metadata, status, stage, progress, result, error }

// Listen for extension installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('SpeakToText Local installed');
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

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'checkServer') {
    checkServerConnection()
      .then(connected => sendResponse({ connected }))
      .catch(() => sendResponse({ connected: false }));
    return true;
  }

  if (request.action === 'trackJob') {
    // Start tracking a job (popup already submitted to server)
    activeJob = {
      id: request.jobId,
      metadata: request.metadata || {},
      status: 'processing',
      stage: 'processing',
      progress: 'Processing...',
      result: null,
      error: null
    };
    startPolling();
    sendResponse({ tracking: true });
    return true;
  }

  if (request.action === 'getJobStatus') {
    sendResponse({ job: activeJob });
    return true;
  }

  if (request.action === 'cancelJob') {
    stopPolling();
    activeJob = null;
    sendResponse({ cancelled: true });
    return true;
  }

  if (request.action === 'clearJob') {
    activeJob = null;
    sendResponse({ cleared: true });
    return true;
  }

  if (request.action === 'getCloudAuthState') {
    getCachedCloudAuthState()
      .then(state => sendResponse({ state }))
      .catch(() => sendResponse({ state: null }));
    return true;
  }
});

// Polling using chrome.alarms (more reliable than setInterval in service workers)
function startPolling() {
  // Clear any existing alarm
  chrome.alarms.clear('pollJob');
  // Poll every 0.5 seconds (minimum is ~1 second for alarms, so we use 1)
  // Actually, let's use a self-invoking approach for faster polling
  pollJobStatus();
}

function stopPolling() {
  chrome.alarms.clear('pollJob');
}

// Poll job status
async function pollJobStatus() {
  if (!activeJob || !activeJob.id) {
    return;
  }

  try {
    const response = await authenticatedFetch(`${SERVER_URL}/job/${activeJob.id}`);
    const job = await response.json();

    if (job.status === 'completed') {
      // Enrich metadata from job response
      if (job.language) {
        activeJob.metadata.language = job.language;
      }
      if (job.duration) {
        activeJob.metadata.duration = job.duration;
      }
      if (job.result?.metadata) {
        activeJob.metadata = { ...activeJob.metadata, ...job.result.metadata };
      }

      activeJob.status = 'completed';
      activeJob.result = job.result;

      // Save result to storage for transcript page
      await chrome.storage.local.set({
        transcriptResult: job.result,
        transcriptMetadata: activeJob.metadata
      });

      console.log('Transcription completed and saved to storage');
      return; // Stop polling

    } else if (job.status === 'error') {
      activeJob.status = 'error';
      activeJob.error = job.error || 'Transcription failed';
      if (job.error_hint) {
        activeJob.error += `\n\n💡 Tip: ${job.error_hint}`;
      }
      console.log('Transcription error:', activeJob.error);
      return; // Stop polling

    } else {
      // Update progress
      activeJob.status = 'processing';
      activeJob.stage = job.stage || 'processing';
      activeJob.progress = job.progress || 'Processing...';
      activeJob.downloadPercent = job.download_percent;

      // Continue polling after a short delay
      setTimeout(pollJobStatus, POLLING_INTERVAL_MS);
    }
  } catch (e) {
    console.log('Poll error, retrying...', e);
    // Retry on network error
    setTimeout(pollJobStatus, 1000);
  }
}

// Also listen to alarms as a backup/keepalive mechanism
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pollJob' && activeJob && activeJob.status === 'processing') {
    pollJobStatus();
  }

  // Refresh Supabase session to prevent token expiry
  if (alarm.name === 'refreshCloudSession') {
    refreshCloudSession().catch(e => console.log('Cloud session refresh error:', e));
  }

  // Retry pending cloud syncs
  if (alarm.name === 'retrySyncQueue') {
    retryPendingSyncs().catch(e => console.log('Sync retry error:', e));
  }
});

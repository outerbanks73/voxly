// SpeakToText Local - Background Service Worker

// This service worker handles background tasks for the extension

// Listen for extension installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('SpeakToText Local installed');
    // Open options page on first install
    chrome.tabs.create({ url: 'options.html' });
  }
});

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'checkServer') {
    fetch('http://localhost:5123/health')
      .then(response => response.ok)
      .then(ok => sendResponse({ connected: ok }))
      .catch(() => sendResponse({ connected: false }));
    return true; // Will respond asynchronously
  }
});

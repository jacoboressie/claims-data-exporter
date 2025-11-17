/**
 * Background Service Worker
 * Minimal service worker for Chrome Extension
 */

console.log('🔧 Claims Data Exporter background service worker loaded');

// Handle installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('🎉 Claims Data Exporter installed');
    
    // Set default settings
    chrome.storage.local.set({
      testMode: false
    });
  }
});


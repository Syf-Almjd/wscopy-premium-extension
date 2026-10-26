/**
 * WS Copy & Export (PRO+ for free) - Background Service Worker
 */

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('⚡ WS Copy & Export (PRO+ for free) installed!');
  }
});

// Handle print tab requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'OPEN_PRINT' || request.type === 'wacopy-print') {
    const html = request.html;
    const storageApi = chrome.storage.session || chrome.storage.local;
    storageApi.set({ printHtml: html }, () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('print.html') });
      sendResponse({ success: true, ok: true });
    });
    return true;
  }
});

// Handle keyboard shortcut (Alt+Shift+C)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-panel') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && tab.url && tab.url.includes('web.whatsapp.com')) {
      chrome.tabs.sendMessage(tab.id, { action: 'OPEN_MODAL' }).catch(() => { });
    }
  }
});

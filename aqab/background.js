/**
 * WACopy Pro - Background Service Worker
 */

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('⚡ WACopy Pro successfully installed!');
  }
});

// Handle print window requests from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'OPEN_PRINT') {
    const storageApi = chrome.storage.session || chrome.storage.local;
    storageApi.set({ printHtml: request.html }, () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('print.html') });
      sendResponse({ success: true });
    });
    return true;
  }
});

// Handle keyboard shortcut (Alt+Shift+C)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-panel') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && tab.url && tab.url.includes('web.whatsapp.com')) {
      chrome.tabs.sendMessage(tab.id, { action: 'OPEN_MODAL' }).catch(() => {});
    }
  }
});

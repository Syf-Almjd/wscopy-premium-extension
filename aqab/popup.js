/**
 * WACopy Pro - Popup Script
 * Coordinates between Extension Popup UI and WhatsApp Web Content Script
 */

document.addEventListener('DOMContentLoaded', async () => {
  const statusDot = document.getElementById('statusDot');
  const statusTitle = document.getElementById('statusTitle');
  const statusSub = document.getElementById('statusSub');
  const activeChatSection = document.getElementById('activeChatSection');
  const noChatSection = document.getElementById('noChatSection');
  const openTabBtn = document.getElementById('openTabBtn');
  const launchWhatsAppBtn = document.getElementById('launchWhatsAppBtn');
  const popupQuickCopyBtn = document.getElementById('popupQuickCopyBtn');
  const popupPromptSelect = document.getElementById('popupPromptSelect');
  const openInPageModalBtn = document.getElementById('openInPageModalBtn');
  const rangePills = document.querySelectorAll('#popupRangePills .pill-btn');
  const exportChips = document.querySelectorAll('.export-chip');

  let activeWhatsAppTab = null;
  let selectedRange = '500';

  /**
   * Find active or existing WhatsApp Web tab
   */
  async function getWhatsAppTab() {
    const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    if (tabs.length > 0) {
      // Prefer active tab if it's WhatsApp Web
      const currentActive = tabs.find((t) => t.active);
      return currentActive || tabs[0];
    }
    return null;
  }

  /**
   * Update UI status
   */
  async function refreshStatus() {
    activeWhatsAppTab = await getWhatsAppTab();

    if (!activeWhatsAppTab) {
      statusDot.className = 'status-indicator-dot error';
      statusTitle.textContent = 'WhatsApp Web Not Open';
      statusSub.textContent = 'Click below to launch';
      activeChatSection.style.display = 'none';
      noChatSection.style.display = 'flex';
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(activeWhatsAppTab.id, { action: 'GET_STATUS' });

      if (response && response.isChatOpen) {
        statusDot.className = 'status-indicator-dot connected';
        statusTitle.textContent = response.chatTitle || 'Connected';
        statusSub.textContent = `Active Conversation (~${response.messageCount || 0} msgs visible)`;
        activeChatSection.style.display = 'block';
        noChatSection.style.display = 'none';
      } else {
        statusDot.className = 'status-indicator-dot';
        statusTitle.textContent = 'WhatsApp Connected';
        statusSub.textContent = 'Select any conversation to start';
        activeChatSection.style.display = 'none';
        noChatSection.style.display = 'flex';
      }
    } catch (err) {
      // Content script may not be loaded yet or page is refreshing
      statusDot.className = 'status-indicator-dot error';
      statusTitle.textContent = 'Connecting...';
      statusSub.textContent = 'Please refresh WhatsApp Web tab';
      activeChatSection.style.display = 'none';
      noChatSection.style.display = 'flex';
    }
  }

  // Open or focus WhatsApp Web tab
  const handleOpenWhatsApp = async () => {
    if (activeWhatsAppTab) {
      await chrome.tabs.update(activeWhatsAppTab.id, { active: true });
      if (activeWhatsAppTab.windowId) {
        await chrome.windows.update(activeWhatsAppTab.windowId, { focused: true });
      }
    } else {
      await chrome.tabs.create({ url: 'https://web.whatsapp.com' });
    }
    window.close();
  };

  openTabBtn.addEventListener('click', handleOpenWhatsApp);
  launchWhatsAppBtn.addEventListener('click', handleOpenWhatsApp);

  // Range selector
  rangePills.forEach((pill) => {
    pill.addEventListener('click', () => {
      rangePills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      selectedRange = pill.getAttribute('data-val');
    });
  });

  // Helper to send action to content script
  async function sendAction(action, extra = {}) {
    if (!activeWhatsAppTab) return;
    try {
      await chrome.tabs.sendMessage(activeWhatsAppTab.id, {
        action,
        config: {
          rangeMode: selectedRange,
          promptType: popupPromptSelect.value,
          ...extra.config
        },
        format: extra.format || 'md'
      });
      // Switch focus to tab so user can see progress / toast
      await chrome.tabs.update(activeWhatsAppTab.id, { active: true });
      window.close();
    } catch (err) {
      console.error('Failed to send action to content script:', err);
    }
  }

  // Quick Copy button
  popupQuickCopyBtn.addEventListener('click', () => {
    sendAction('TRIGGER_COPY');
  });

  // Format chips
  exportChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const fmt = chip.getAttribute('data-fmt');
      sendAction('TRIGGER_EXPORT', { format: fmt });
    });
  });

  // Open in-page modal
  openInPageModalBtn.addEventListener('click', () => {
    sendAction('OPEN_MODAL');
  });

  // Initial load
  await refreshStatus();
});

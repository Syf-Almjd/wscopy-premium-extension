/**
 * Simple WhatsApp Copier (PRO+ for free) - Popup Script
 * Self-contained control center: all options, exports, and copy actions run from here.
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
  const rangePills = document.querySelectorAll('#popupRangePills .pill-btn');
  const exportChips = document.querySelectorAll('.export-chip');
  const toggleAdvBtn = document.getElementById('popupToggleAdvanced');
  const advDrawer = document.getElementById('popupAdvancedDrawer');
  const arrowSpan = document.getElementById('popupArrow');

  // Advanced option inputs
  const optImages = document.getElementById('popOptImages');
  const optEmbed = document.getElementById('popOptEmbed');
  const optVoice = document.getElementById('popOptVoice');
  const optGroqKey = document.getElementById('popGroqKey');
  const optDateStart = document.getElementById('popDateStart');
  const optDateEnd = document.getElementById('popDateEnd');
  const optPrompt = document.getElementById('popPromptSelect');
  const optCustomPrompt = document.getElementById('popCustomPrompt');
  const optTime = document.getElementById('popOptTime');
  const optSender = document.getElementById('popOptSender');
  const optQuote = document.getElementById('popOptQuote');
  const optReact = document.getElementById('popOptReact');
  const btnJson = document.getElementById('popBtnJson');

  let activeWhatsAppTab = null;
  let selectedRange = '500';

  // Load saved preferences
  chrome.storage.local.get(['swc_groq_key', 'swc_prompt', 'swc_range'], (res) => {
    if (res?.swc_groq_key && optGroqKey) optGroqKey.value = res.swc_groq_key;
    if (res?.swc_prompt && optPrompt) optPrompt.value = res.swc_prompt;
    if (res?.swc_range) {
      selectedRange = res.swc_range;
      rangePills.forEach((p) => {
        p.classList.toggle('active', p.getAttribute('data-val') === selectedRange);
      });
    }
  });

  /**
   * Robust tab finder: checks active tab, all tabs, and URL patterns
   */
  async function getWhatsAppTab() {
    try {
      // 1. Check current active tab in current window
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (currentTab && currentTab.url && currentTab.url.includes('web.whatsapp.com')) {
        return currentTab;
      }

      // 2. Query any active tab across windows
      const activeTabs = await chrome.tabs.query({ active: true });
      const activeWA = activeTabs.find((t) => t.url && t.url.includes('web.whatsapp.com'));
      if (activeWA) return activeWA;

      // 3. Query all tabs to find WhatsApp Web
      const allTabs = await chrome.tabs.query({});
      const waTab = allTabs.find((t) => t.url && t.url.includes('web.whatsapp.com'));
      if (waTab) return waTab;

      // 4. Pattern fallback
      const patternTabs = await chrome.tabs.query({ url: '*://web.whatsapp.com/*' });
      if (patternTabs && patternTabs.length > 0) return patternTabs[0];
    } catch (e) {
      console.warn('Error querying tabs:', e);
    }
    return null;
  }

  /**
   * Ensure content script is injected even if WhatsApp tab was opened before extension reload
   */
  async function ensureContentScript(tabId) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { action: 'PING' });
      if (pong && pong.pong) return true;
    } catch (e) {
      // Inject scripts dynamically
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['exporter.js', 'content.js']
        });
        await chrome.scripting.insertCSS({
          target: { tabId },
          files: ['content.css']
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 200));
        return true;
      } catch (err2) {
        console.warn('Script injection failed:', err2);
        return false;
      }
    }
    return true;
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

    // Ensure content script is loaded
    await ensureContentScript(activeWhatsAppTab.id);

    // ALWAYS show controls when WhatsApp Web tab exists
    activeChatSection.style.display = 'block';
    noChatSection.style.display = 'none';

    try {
      const response = await chrome.tabs.sendMessage(activeWhatsAppTab.id, { action: 'GET_STATUS' });

      if (response && response.isChatOpen) {
        statusDot.className = 'status-indicator-dot connected';
        statusTitle.textContent = response.chatTitle || 'Connected';
        statusSub.textContent = `Active Chat (~${response.messageCount || 0} msgs visible)`;
      } else {
        statusDot.className = 'status-indicator-dot';
        statusTitle.textContent = 'WhatsApp Connected';
        statusSub.textContent = 'Select any chat in WhatsApp Web to export';
      }
    } catch (err) {
      statusDot.className = 'status-indicator-dot';
      statusTitle.textContent = 'WhatsApp Tab Ready';
      statusSub.textContent = 'Ready to copy or export';
    }
  }

  // Open or focus WhatsApp Web tab
  const handleOpenWhatsApp = async () => {
    activeWhatsAppTab = await getWhatsAppTab();
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

  if (openTabBtn) openTabBtn.addEventListener('click', handleOpenWhatsApp);
  if (launchWhatsAppBtn) launchWhatsAppBtn.addEventListener('click', handleOpenWhatsApp);

  // Toggle Advanced Options Accordion right in popup
  if (toggleAdvBtn) {
    toggleAdvBtn.addEventListener('click', () => {
      const isOpen = advDrawer.classList.toggle('open');
      if (arrowSpan) arrowSpan.textContent = isOpen ? '▴' : '▾';
    });
  }

  // Prompt selector
  if (optPrompt) {
    optPrompt.addEventListener('change', () => {
      if (optCustomPrompt) optCustomPrompt.style.display = optPrompt.value === 'custom' ? 'block' : 'none';
      chrome.storage.local.set({ swc_prompt: optPrompt.value });
    });
  }

  // Save Groq key on change
  if (optGroqKey) {
    optGroqKey.addEventListener('change', () => {
      chrome.storage.local.set({ swc_groq_key: optGroqKey.value.trim() });
    });
  }

  // Range pills selector
  rangePills.forEach((pill) => {
    pill.addEventListener('click', () => {
      rangePills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      selectedRange = pill.getAttribute('data-val');
      chrome.storage.local.set({ swc_range: selectedRange });
    });
  });

  /**
   * Safely build configuration object (No undefined references!)
   */
  function buildConfig() {
    return {
      rangeMode: selectedRange,
      startDate: optDateStart?.value || '',
      endDate: optDateEnd?.value || '',
      promptType: optPrompt?.value || 'none',
      customPrompt: optCustomPrompt?.value || '',
      includeTimestamps: optTime ? optTime.checked : true,
      includeSenders: optSender ? optSender.checked : true,
      includeQuotes: optQuote ? optQuote.checked : true,
      includeReactions: optReact ? optReact.checked : true,
      trackImages: optImages ? optImages.checked : true,
      embedImages: optEmbed ? optEmbed.checked : true,
      transcribeVoice: optVoice ? optVoice.checked : true,
      groqApiKey: optGroqKey?.value ? optGroqKey.value.trim() : ''
    };
  }

  /**
   * Helper to dispatch actions to content script safely
   */
  async function sendAction(action, extra = {}) {
    activeWhatsAppTab = await getWhatsAppTab();
    if (!activeWhatsAppTab) {
      alert('Please open WhatsApp Web first!');
      return;
    }

    try {
      await ensureContentScript(activeWhatsAppTab.id);
      const fullConfig = buildConfig();

      await chrome.tabs.sendMessage(activeWhatsAppTab.id, {
        action,
        config: fullConfig,
        format: extra.format || 'zip'
      });

      // Switch focus to WhatsApp tab so user sees the download progress & toast
      await chrome.tabs.update(activeWhatsAppTab.id, { active: true });
      if (activeWhatsAppTab.windowId) {
        await chrome.windows.update(activeWhatsAppTab.windowId, { focused: true });
      }

      setTimeout(() => window.close(), 150);
    } catch (err) {
      console.error('Failed to send action to WhatsApp tab:', err);
      alert('Error communicating with WhatsApp Web: ' + err.message);
    }
  }

  // 1-Click AI Copy button
  if (popupQuickCopyBtn) {
    popupQuickCopyBtn.addEventListener('click', () => {
      sendAction('TRIGGER_COPY');
    });
  }

  // 1-Click Format Chips (including ZIP)
  exportChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const fmt = chip.getAttribute('data-fmt');
      sendAction('TRIGGER_EXPORT', { format: fmt });
    });
  });

  // Raw JSON button in advanced
  if (btnJson) {
    btnJson.addEventListener('click', () => {
      sendAction('TRIGGER_EXPORT', { format: 'json' });
    });
  }

  // Initial load
  await refreshStatus();
});

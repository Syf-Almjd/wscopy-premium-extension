/**
 * WACopy Pro - Content Script
 * Injected into WhatsApp Web (https://web.whatsapp.com)
 * Features:
 * - Scrapes chat history with smart virtual-scroll loader (Unlimited & Free)
 * - Injects floating & header buttons
 * - Modern Glassmorphism Modal for instant AI copy and file exports
 * - Full support for Markdown, TXT, HTML, PDF, CSV, JSON
 */

(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__WACOPY_LOADED__) return;
  window.__WACOPY_LOADED__ = true;

  console.log('⚡ WACopy Pro: Initialized on WhatsApp Web');

  // State
  let isScrapingActive = false;
  let shouldCancelScraping = false;
  let activeModalElement = null;
  let activeProgressElement = null;

  // Selected configurations
  const currentConfig = {
    rangeMode: '500', // 'visible', '100', '500', '2000', 'all', 'daterange'
    startDate: '',
    endDate: '',
    promptType: 'none',
    customPrompt: '',
    includeTimestamps: true,
    includeSenders: true,
    includeMedia: true,
    includeQuotes: true,
    includeReactions: true
  };

  /**
   * Helper: Sleep
   */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Helper: Show Toast Notification
   */
  function showToast(message, icon = '✅') {
    let toast = document.getElementById('wacopyToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'wacopyToast';
      toast.className = 'wacopy-toast';
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span class="wacopy-toast-icon">${icon}</span> <span>${message}</span>`;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 3200);
  }

  /**
   * Detect current open chat
   */
  function isChatOpen() {
    return !!document.querySelector('#main header');
  }

  /**
   * Get Active Chat Title
   */
  function getChatTitle() {
    const header = document.querySelector('#main header');
    if (!header) return 'WhatsApp Chat';
    const titleSpan =
      header.querySelector('span[dir="auto"]') ||
      header.querySelector('span[title]') ||
      header.querySelector('div[role="button"] span');
    return titleSpan?.getAttribute('title') || titleSpan?.innerText || 'WhatsApp Chat';
  }

  /**
   * Find the scrollable message container
   */
  function getMessagesScrollContainer() {
    const main = document.querySelector('#main');
    if (!main) return null;

    // Direct testid container
    const testidEl = main.querySelector('[data-testid="conversation-panel-messages"]');
    if (testidEl) return testidEl;

    // Search for overflow scroll container inside #main
    const candidates = main.querySelectorAll('div');
    for (const d of candidates) {
      const style = window.getComputedStyle(d);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        d.scrollHeight > d.clientHeight &&
        d.clientHeight > 200
      ) {
        return d;
      }
    }
    return main.querySelector('div[role="application"]') || main;
  }

  /**
   * Parse a single message DOM node
   */
  function parseMessageElement(el) {
    const msgId = el.getAttribute('data-id') || el.id || '';
    const isOutgoing = el.classList.contains('message-out') || (msgId && msgId.startsWith('true_'));

    // Check data-pre-plain-text attribute
    const copyable = el.querySelector('.copyable-text');
    const prePlainText = copyable?.getAttribute('data-pre-plain-text') || '';

    let timestamp = '';
    let sender = isOutgoing ? 'You' : '';
    let date = '';
    let time = '';

    if (prePlainText) {
      // Format: [10:45 AM, 10/24/2026] Name:
      const match = prePlainText.match(/\[(.*?)\]\s*(.*?):\s*$/);
      if (match) {
        timestamp = match[1].trim();
        if (!isOutgoing) {
          sender = match[2].trim();
        }
        const parts = timestamp.split(',');
        if (parts.length === 2) {
          if (parts[0].includes(':')) {
            time = parts[0].trim();
            date = parts[1].trim();
          } else {
            date = parts[0].trim();
            time = parts[1].trim();
          }
        }
      }
    }

    // Sender fallback
    if (!sender) {
      if (isOutgoing) {
        sender = 'You';
      } else {
        const authorEl = el.querySelector('span[data-testid="author"]');
        sender = authorEl?.innerText || getChatTitle();
      }
    }

    // Time fallback
    if (!timestamp) {
      const metaEl = el.querySelector('[data-testid="msg-meta"]');
      time = metaEl?.innerText?.replace(/[\r\n\t]/g, ' ').trim() || '';
      timestamp = time;
    }

    // Message Text
    let text = '';
    const textEl = el.querySelector('span.selectable-text, .copyable-text span[dir]');
    if (textEl) {
      text = textEl.innerText.trim();
    }

    // Quoted reply
    let quoted = null;
    const quotedEl = el.querySelector('[data-testid="quoted-message"], [data-testid="quoted-msg"]');
    if (quotedEl) {
      const qSender = quotedEl.querySelector('span[dir="auto"]')?.innerText || 'Reply';
      const qText = quotedEl.innerText.replace(qSender, '').trim();
      quoted = { sender: qSender, text: qText };
    }

    // Media type identification
    let mediaType = null;
    let mediaInfo = null;

    if (el.querySelector('[data-testid="audio-play"], [data-testid="ptt-play"]')) {
      mediaType = 'Voice Note';
      const dur = el.querySelector('span[data-testid="audio-duration"]')?.innerText;
      if (dur) mediaInfo = dur;
    } else if (el.querySelector('img[src*="blob:"], [data-testid="image-thumb"]')) {
      mediaType = 'Image';
    } else if (el.querySelector('video, [data-testid="video-thumb"]')) {
      mediaType = 'Video';
    } else if (el.querySelector('[data-testid="document-thumb"]')) {
      mediaType = 'Document';
      const docTitle = el.querySelector('span[title], div[title]')?.getAttribute('title');
      if (docTitle) mediaInfo = docTitle;
    } else if (el.querySelector('[data-testid="sticker"]')) {
      mediaType = 'Sticker';
    } else if (el.querySelector('[data-testid="location"]')) {
      mediaType = 'Location';
    } else if (el.querySelector('[data-testid="vcard"]')) {
      mediaType = 'Contact';
    } else if (el.querySelector('[data-testid="poll-bubble"]')) {
      mediaType = 'Poll';
    } else if (el.querySelector('[data-testid="recalled-msg"]')) {
      mediaType = 'Deleted Message';
      text = '[This message was deleted]';
    }

    // Reactions
    const reactions = [];
    const reactionBubbles = el.querySelectorAll('[data-testid="reactions-bubble"] span, [aria-label*="reaction"]');
    reactionBubbles.forEach((r) => {
      const t = r.innerText.trim();
      if (t) reactions.push(t);
    });

    const uniqueId = msgId || `${sender}_${timestamp}_${text.substring(0, 30)}`;

    return {
      id: uniqueId,
      isOutgoing,
      sender,
      timestamp,
      date,
      time,
      text,
      quoted,
      mediaType,
      mediaInfo,
      reactions
    };
  }

  /**
   * Scrape Chat Messages with Smart Virtual-Scroll Loader
   */
  async function scrapeChat(rangeMode, options = {}, onProgress = null) {
    if (!isChatOpen()) {
      throw new Error('Please open a WhatsApp chat first!');
    }

    const container = getMessagesScrollContainer();
    const scrapedMap = new Map();
    let targetLimit = Infinity;

    if (rangeMode === 'visible') {
      targetLimit = 0; // immediate
    } else if (rangeMode === 'all') {
      targetLimit = Infinity;
    } else if (!isNaN(parseInt(rangeMode, 10))) {
      targetLimit = parseInt(rangeMode, 10);
    }

    isScrapingActive = true;
    shouldCancelScraping = false;

    let noNewMessagesRounds = 0;
    let prevCount = 0;
    const initialScrollTop = container ? container.scrollTop : 0;

    try {
      while (isScrapingActive && !shouldCancelScraping) {
        // Query visible message elements
        const messageElements = document.querySelectorAll(
          '#main div[data-id], #main .message-in, #main .message-out'
        );

        for (const el of messageElements) {
          const msg = parseMessageElement(el);
          if (msg && !scrapedMap.has(msg.id)) {
            scrapedMap.set(msg.id, msg);
          }
        }

        if (onProgress) {
          onProgress(scrapedMap.size);
        }

        // Check if we hit limit
        if (rangeMode === 'visible' || scrapedMap.size >= targetLimit) {
          break;
        }

        // Check if reached top of chat
        const isSecurityBubblePresent = !!document.querySelector(
          '#main div[data-testid="chat-security-bubble"]'
        );
        const atTop = container && container.scrollTop <= 10;

        if (isSecurityBubblePresent || (atTop && scrapedMap.size === prevCount)) {
          noNewMessagesRounds++;
          if (noNewMessagesRounds >= 3) {
            console.log('⚡ WACopy Pro: Reached top of conversation history');
            break;
          }
        } else {
          noNewMessagesRounds = 0;
        }

        prevCount = scrapedMap.size;

        // Scroll up to trigger virtual scroll batch load
        if (container) {
          container.scrollTop = 0;
        }
        await sleep(550);
      }
    } finally {
      isScrapingActive = false;
      // Restore scroll if user was at bottom
      if (container && initialScrollTop > 0) {
        container.scrollTop = container.scrollHeight;
      }
    }

    // Convert map to array
    let messages = Array.from(scrapedMap.values());

    // Sort chronologically (earliest to latest)
    // WhatsApp messages inside DOM are ordered, but we can verify
    // Trim to targetLimit if user picked fixed number
    if (typeof targetLimit === 'number' && targetLimit > 0 && messages.length > targetLimit) {
      messages = messages.slice(messages.length - targetLimit);
    }

    // Date range filter if specified
    if (options.startDate || options.endDate) {
      const start = options.startDate ? new Date(options.startDate).getTime() : 0;
      const end = options.endDate ? new Date(options.endDate).setHours(23, 59, 59, 999) : Infinity;

      messages = messages.filter((m) => {
        if (!m.date) return true;
        const msgDate = new Date(m.date).getTime();
        if (isNaN(msgDate)) return true;
        return msgDate >= start && msgDate <= end;
      });
    }

    const chatTitle = getChatTitle();
    const dateRange = {
      start: messages[0]?.date || messages[0]?.timestamp || '',
      end: messages[messages.length - 1]?.date || messages[messages.length - 1]?.timestamp || ''
    };

    return {
      chatTitle,
      totalCount: messages.length,
      dateRange,
      messages
    };
  }

  /**
   * Render Scraping Progress Overlay
   */
  function showProgressModal(onStopCallback) {
    if (activeProgressElement) activeProgressElement.remove();

    const overlay = document.createElement('div');
    overlay.className = 'wacopy-modal-overlay';
    overlay.id = 'wacopyProgressOverlay';
    overlay.innerHTML = `
      <div class="wacopy-progress-card">
        <div class="wacopy-spinner"></div>
        <div class="wacopy-progress-stats">
          <div class="wacopy-progress-count" id="wacopyProgressNum">0</div>
          <div class="wacopy-progress-sub">Messages Scraped So Far...</div>
        </div>
        <p style="font-size: 12px; color: var(--wacopy-text-muted); max-width: 260px; line-height: 1.4;">
          Scrolling through WhatsApp Web history locally on your device.
        </p>
        <button class="wacopy-btn-stop-export" id="wacopyBtnStop">Stop & Export Now</button>
      </div>
    `;

    document.body.appendChild(overlay);
    activeProgressElement = overlay;

    overlay.querySelector('#wacopyBtnStop').addEventListener('click', () => {
      shouldCancelScraping = true;
      if (onStopCallback) onStopCallback();
    });

    return {
      updateCount: (num) => {
        const countEl = overlay.querySelector('#wacopyProgressNum');
        if (countEl) countEl.textContent = num;
      },
      close: () => {
        if (activeProgressElement) {
          activeProgressElement.remove();
          activeProgressElement = null;
        }
      }
    };
  }

  /**
   * Main Export/Copy Handler
   */
  async function performAction(actionType, format = 'md') {
    if (!isChatOpen()) {
      showToast('Please open a WhatsApp chat first!', '⚠️');
      return;
    }

    const range = currentConfig.rangeMode;
    let progress = null;

    if (range !== 'visible') {
      progress = showProgressModal(() => {
        console.log('⚡ WACopy Pro: User stopped scraping');
      });
    }

    try {
      const chatData = await scrapeChat(
        range,
        {
          startDate: currentConfig.startDate,
          endDate: currentConfig.endDate
        },
        (count) => {
          if (progress) progress.updateCount(count);
        }
      );

      if (progress) progress.close();

      if (!chatData.messages || chatData.messages.length === 0) {
        showToast('No messages found to export!', '⚠️');
        return;
      }

      const options = {
        promptType: currentConfig.promptType,
        customPrompt: currentConfig.customPrompt,
        includeTimestamps: currentConfig.includeTimestamps,
        includeSenders: currentConfig.includeSenders,
        includeMedia: currentConfig.includeMedia,
        includeQuotes: currentConfig.includeQuotes,
        includeReactions: currentConfig.includeReactions
      };

      const sanitizedTitle = (chatData.chatTitle || 'chat')
        .replace(/[^a-zA-Z0-9_\u0600-\u06FF\s-]/g, '')
        .trim()
        .replace(/\s+/g, '_');
      const filenameBase = `WhatsApp_${sanitizedTitle}_${new Date().toISOString().slice(0, 10)}`;

      if (actionType === 'copy') {
        const markdown = WACopyExporter.toMarkdown(chatData, options);
        const success = await WACopyExporter.copyToClipboard(markdown);
        if (success) {
          showToast(`Copied ${chatData.messages.length} messages for ChatGPT!`, '📋');
        } else {
          showToast('Failed to copy to clipboard', '❌');
        }
      } else if (actionType === 'export') {
        switch (format) {
          case 'md': {
            const md = WACopyExporter.toMarkdown(chatData, options);
            WACopyExporter.downloadFile(md, `${filenameBase}.md`, 'text/markdown');
            showToast(`Exported ${chatData.messages.length} messages as Markdown!`, '📥');
            break;
          }
          case 'txt': {
            const txt = WACopyExporter.toPlainText(chatData, options);
            WACopyExporter.downloadFile(txt, `${filenameBase}.txt`, 'text/plain');
            showToast(`Exported as Plain Text!`, '📥');
            break;
          }
          case 'html': {
            const html = WACopyExporter.toHTML(chatData, options);
            WACopyExporter.downloadFile(html, `${filenameBase}.html`, 'text/html');
            showToast(`Exported as Offline HTML Viewer!`, '🌐');
            break;
          }
          case 'csv': {
            const csv = WACopyExporter.toCSV(chatData, options);
            WACopyExporter.downloadFile(csv, `${filenameBase}.csv`, 'text/csv');
            showToast(`Exported as CSV!`, '📊');
            break;
          }
          case 'json': {
            const json = WACopyExporter.toJSON(chatData, options);
            WACopyExporter.downloadFile(json, `${filenameBase}.json`, 'application/json');
            showToast(`Exported as JSON!`, '🗄️');
            break;
          }
          case 'pdf': {
            WACopyExporter.printPDF(chatData, options);
            showToast(`Opening Print / PDF dialog...`, '🖨️');
            break;
          }
        }
      }
    } catch (err) {
      if (progress) progress.close();
      console.error('WACopy Pro error:', err);
      showToast(`Error: ${err.message}`, '❌');
    }
  }

  /**
   * Render WACopy Pro In-Page Modal
   */
  function openMainModal() {
    if (activeModalElement) activeModalElement.remove();

    const title = getChatTitle();
    const visibleCount = document.querySelectorAll('#main div[data-id], #main .message-in, #main .message-out').length;

    const overlay = document.createElement('div');
    overlay.className = 'wacopy-modal-overlay';
    overlay.id = 'wacopyMainModal';

    overlay.innerHTML = `
      <div class="wacopy-modal">
        <!-- Header -->
        <div class="wacopy-modal-header">
          <div class="wacopy-header-title-box">
            <div class="wacopy-logo-icon">⚡</div>
            <div>
              <h2>WACopy Pro <span class="wacopy-badge-pro">UNLIMITED</span></h2>
              <p>100% Free & Local WhatsApp Chat Exporter</p>
            </div>
          </div>
          <button class="wacopy-close-btn" id="wacopyModalClose">&times;</button>
        </div>

        <!-- Body -->
        <div class="wacopy-modal-body">
          <!-- Active Chat Card -->
          <div class="wacopy-chat-info-card">
            <div class="wacopy-chat-avatar">${title.charAt(0).toUpperCase()}</div>
            <div class="wacopy-chat-details">
              <div class="wacopy-chat-name">${title}</div>
              <div class="wacopy-chat-sub">~${visibleCount} messages visible in view</div>
            </div>
          </div>

          <!-- Quick Copy AI Banner -->
          <div class="wacopy-quick-copy-box">
            <div class="wacopy-quick-copy-title">
              <span>🤖 One-Click AI Copy</span>
              <span style="font-size: 11.5px; color: var(--wacopy-text-muted);">ChatGPT &bull; Claude &bull; Notion</span>
            </div>
            <button class="wacopy-btn-copy-ai" id="wacopyBtnQuickCopy">
              <span>📋 Copy Chat to Clipboard (Markdown)</span>
            </button>
          </div>

          <!-- Message Range Selection -->
          <div class="wacopy-section">
            <span class="wacopy-section-label">Select Message Range</span>
            <div class="wacopy-grid-options" id="wacopyRangeGrid">
              <div class="wacopy-radio-btn" data-range="visible">⚡ Visible Only</div>
              <div class="wacopy-radio-btn" data-range="100">100 Messages</div>
              <div class="wacopy-radio-btn active" data-range="500">500 Messages</div>
              <div class="wacopy-radio-btn" data-range="2000">2,000 Messages</div>
              <div class="wacopy-radio-btn" data-range="all">♾️ Entire History</div>
              <div class="wacopy-radio-btn" data-range="daterange">📅 Date Range</div>
            </div>
            <div class="wacopy-date-range-box" id="wacopyDateRangeInputs" style="display: none;">
              <input type="date" id="wacopyStartDate" placeholder="Start Date" />
              <input type="date" id="wacopyEndDate" placeholder="End Date" />
            </div>
          </div>

          <!-- AI Prompt Template -->
          <div class="wacopy-section">
            <span class="wacopy-section-label">Prepend AI Prompt Template</span>
            <select class="wacopy-select" id="wacopyPromptSelect">
              <option value="none">No Prompt (Raw Chat Only)</option>
              <option value="summary">📝 Summarize discussion, agreements & next steps</option>
              <option value="action_items">📋 Extract action items, tasks & assignees</option>
              <option value="meeting_notes">📑 Convert to formal meeting minutes</option>
              <option value="qa_insights">💡 Extract key questions, answers & resources</option>
              <option value="custom">✏️ Custom Prompt...</option>
            </select>
            <textarea id="wacopyCustomPromptInput" style="display: none; width: 100%; height: 60px; background: var(--wacopy-card-bg); border: 1px solid var(--wacopy-border); border-radius: 8px; color: var(--wacopy-text); padding: 8px; font-size: 12.5px; margin-top: 6px;" placeholder="Write your instructions for ChatGPT / Claude..."></textarea>
          </div>

          <!-- Format Export Grid -->
          <div class="wacopy-section">
            <span class="wacopy-section-label">Download Export File</span>
            <div class="wacopy-export-buttons-grid">
              <button class="wacopy-export-btn" data-fmt="md">
                <span class="fmt-icon">📝</span>
                <span>Markdown</span>
                <span class="fmt-badge">.md</span>
              </button>
              <button class="wacopy-export-btn" data-fmt="html">
                <span class="fmt-icon">🌐</span>
                <span>HTML Viewer</span>
                <span class="fmt-badge">.html</span>
              </button>
              <button class="wacopy-export-btn" data-fmt="pdf">
                <span class="fmt-icon">🖨️</span>
                <span>PDF Print</span>
                <span class="fmt-badge">.pdf</span>
              </button>
              <button class="wacopy-export-btn" data-fmt="txt">
                <span class="fmt-icon">📄</span>
                <span>Plain Text</span>
                <span class="fmt-badge">.txt</span>
              </button>
              <button class="wacopy-export-btn" data-fmt="csv">
                <span class="fmt-icon">📊</span>
                <span>Excel / CSV</span>
                <span class="fmt-badge">.csv</span>
              </button>
              <button class="wacopy-export-btn" data-fmt="json">
                <span class="fmt-icon">🗄️</span>
                <span>Raw JSON</span>
                <span class="fmt-badge">.json</span>
              </button>
            </div>
          </div>

          <!-- Metadata Toggles -->
          <div class="wacopy-section">
            <span class="wacopy-section-label">Formatting Options</span>
            <div class="wacopy-checkbox-row">
              <span>Include Timestamps</span>
              <label class="wacopy-switch">
                <input type="checkbox" id="wacopyOptTimestamps" checked>
                <span class="wacopy-slider"></span>
              </label>
            </div>
            <div class="wacopy-checkbox-row">
              <span>Include Sender Names</span>
              <label class="wacopy-switch">
                <input type="checkbox" id="wacopyOptSenders" checked>
                <span class="wacopy-slider"></span>
              </label>
            </div>
            <div class="wacopy-checkbox-row">
              <span>Include Media Tags (Images, Audio, Docs)</span>
              <label class="wacopy-switch">
                <input type="checkbox" id="wacopyOptMedia" checked>
                <span class="wacopy-slider"></span>
              </label>
            </div>
            <div class="wacopy-checkbox-row">
              <span>Include Quoted / Replied Messages</span>
              <label class="wacopy-switch">
                <input type="checkbox" id="wacopyOptQuotes" checked>
                <span class="wacopy-slider"></span>
              </label>
            </div>
            <div class="wacopy-checkbox-row">
              <span>Include Reactions</span>
              <label class="wacopy-switch">
                <input type="checkbox" id="wacopyOptReactions" checked>
                <span class="wacopy-slider"></span>
              </label>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    activeModalElement = overlay;

    // Events inside modal
    overlay.querySelector('#wacopyModalClose').addEventListener('click', () => {
      overlay.remove();
      activeModalElement = null;
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        activeModalElement = null;
      }
    });

    // Range selector click
    const rangeButtons = overlay.querySelectorAll('#wacopyRangeGrid .wacopy-radio-btn');
    const dateRangeBox = overlay.querySelector('#wacopyDateRangeInputs');
    rangeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        rangeButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const selected = btn.getAttribute('data-range');
        currentConfig.rangeMode = selected;
        dateRangeBox.style.display = selected === 'daterange' ? 'flex' : 'none';
      });
    });

    // Date range inputs
    const startInput = overlay.querySelector('#wacopyStartDate');
    const endInput = overlay.querySelector('#wacopyEndDate');
    startInput.addEventListener('change', (e) => (currentConfig.startDate = e.target.value));
    endInput.addEventListener('change', (e) => (currentConfig.endDate = e.target.value));

    // Prompt select
    const promptSelect = overlay.querySelector('#wacopyPromptSelect');
    const customPromptInput = overlay.querySelector('#wacopyCustomPromptInput');
    promptSelect.addEventListener('change', (e) => {
      currentConfig.promptType = e.target.value;
      customPromptInput.style.display = e.target.value === 'custom' ? 'block' : 'none';
    });
    customPromptInput.addEventListener('input', (e) => {
      currentConfig.customPrompt = e.target.value;
    });

    // Checkboxes
    const bindToggle = (id, prop) => {
      const el = overlay.querySelector(id);
      el.addEventListener('change', (e) => {
        currentConfig[prop] = e.target.checked;
      });
    };
    bindToggle('#wacopyOptTimestamps', 'includeTimestamps');
    bindToggle('#wacopyOptSenders', 'includeSenders');
    bindToggle('#wacopyOptMedia', 'includeMedia');
    bindToggle('#wacopyOptQuotes', 'includeQuotes');
    bindToggle('#wacopyOptReactions', 'includeReactions');

    // Quick Copy button
    overlay.querySelector('#wacopyBtnQuickCopy').addEventListener('click', () => {
      overlay.remove();
      activeModalElement = null;
      performAction('copy');
    });

    // Format download buttons
    overlay.querySelectorAll('.wacopy-export-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fmt = btn.getAttribute('data-fmt');
        overlay.remove();
        activeModalElement = null;
        performAction('export', fmt);
      });
    });
  }

  /**
   * In-Chat Header Button & Floating Widget Injector
   */
  function injectUI() {
    // 1. Injected Header Button inside WhatsApp chat header
    const header = document.querySelector('#main header');
    if (header && !header.querySelector('#wacopyHeaderBtn')) {
      const headerBtn = document.createElement('button');
      headerBtn.id = 'wacopyHeaderBtn';
      headerBtn.className = 'wacopy-header-btn';
      headerBtn.title = 'WACopy Pro - Export / Copy Chat';
      headerBtn.innerHTML = `
        <svg viewBox="0 0 24 24">
          <path d="M16 1H4C2.9 1 2 1.9 2 3v14h2V3h12V1zm3 4H8C6.9 5 6 5.9 6 7v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
        </svg>
        <span>WACopy</span>
      `;
      headerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openMainModal();
      });

      // Insert near the last action buttons inside header
      const actionContainer = header.querySelector('div:last-child') || header;
      actionContainer.parentNode.insertBefore(headerBtn, actionContainer);
    }

    // 2. Persistent Floating Button (Bottom Right)
    if (!document.getElementById('wacopyFloatingWidget') && document.body) {
      const widget = document.createElement('div');
      widget.id = 'wacopyFloatingWidget';
      widget.className = 'wacopy-floating-widget';
      widget.title = 'WACopy Pro - Unlimited Exporter';
      widget.innerHTML = `
        <span>⚡ WACopy</span>
        <span class="wacopy-badge-pro">PRO</span>
      `;
      widget.addEventListener('click', () => {
        if (!isChatOpen()) {
          showToast('Open any chat in WhatsApp Web first!', '💬');
          return;
        }
        openMainModal();
      });
      document.body.appendChild(widget);
    }
  }

  // Observer to inject UI when DOM changes (e.g. user opens a chat)
  const observer = new MutationObserver(() => {
    injectUI();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Initial attempt
  setTimeout(injectUI, 1000);

  /**
   * Listen for messages from extension popup
   */
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'GET_STATUS') {
        const isOpen = isChatOpen();
        sendResponse({
          isChatOpen: isOpen,
          chatTitle: isOpen ? getChatTitle() : null,
          messageCount: isOpen
            ? document.querySelectorAll('#main div[data-id], #main .message-in, #main .message-out').length
            : 0
        });
        return true;
      }

      if (request.action === 'OPEN_MODAL') {
        if (!isChatOpen()) {
          showToast('Please select a chat in WhatsApp Web first', '💬');
        } else {
          openMainModal();
        }
        sendResponse({ success: true });
        return true;
      }

      if (request.action === 'TRIGGER_COPY') {
        if (request.config) Object.assign(currentConfig, request.config);
        performAction('copy');
        sendResponse({ started: true });
        return true;
      }

      if (request.action === 'TRIGGER_EXPORT') {
        if (request.config) Object.assign(currentConfig, request.config);
        performAction('export', request.format || 'md');
        sendResponse({ started: true });
        return true;
      }
    });
  }
})();

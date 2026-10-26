/**
 * Simple WhatsApp Copier (PRO+ for free) - Content Script
 * Injected into WhatsApp Web (https://web.whatsapp.com)
 */

(function () {
  'use strict';

  if (window.__SWC_LOADED__) return;
  window.__SWC_LOADED__ = true;

  console.log('⚡ Simple WhatsApp Copier (PRO+ for free): Initialized');

  // State
  let isScrapingActive = false;
  let shouldCancelScraping = false;
  let activeModalElement = null;
  let activeProgressElement = null;

  // Configuration state with persistent settings
  const config = {
    rangeMode: '500', // 'visible', '100', '500', '2000', 'all', 'daterange'
    startDate: '',
    endDate: '',
    promptType: 'none',
    customPrompt: '',
    includeTimestamps: true,
    includeSenders: true,
    includeQuotes: true,
    includeReactions: true,
    trackImages: true,
    embedImages: true,
    transcribeVoice: true,
    groqApiKey: '' // optional free Groq Whisper key
  };

  // Load saved API key & options
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['swc_groq_key', 'swc_prompt'], (res) => {
      if (res?.swc_groq_key) config.groqApiKey = res.swc_groq_key;
      if (res?.swc_prompt) config.promptType = res.swc_prompt;
    });
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Show toast feedback
   */
  function showToast(message, icon = '✅') {
    let toast = document.getElementById('swcToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'swcToast';
      toast.className = 'swc-toast';
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3500);
  }

  function isChatOpen() {
    return !!document.querySelector('#main header');
  }

  function getChatTitle() {
    const header = document.querySelector('#main header');
    if (!header) return 'WhatsApp Chat';
    const titleSpan =
      header.querySelector('span[dir="auto"]') ||
      header.querySelector('span[title]') ||
      header.querySelector('div[role="button"] span');
    return titleSpan?.getAttribute('title') || titleSpan?.innerText || 'WhatsApp Chat';
  }

  function getMessagesScrollContainer() {
    const main = document.querySelector('#main');
    if (!main) return null;

    const testidEl = main.querySelector('[data-testid="conversation-panel-messages"]');
    if (testidEl) return testidEl;

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
   * Helper: Convert Blob URL to base64 Data URL and raw Blob
   */
  async function fetchBlobData(blobUrl) {
    try {
      const res = await fetch(blobUrl);
      const blob = await res.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve({ dataUrl: reader.result, blob });
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      return null;
    }
  }

  /**
   * AI Voice Note Transcriber
   * Checks for native WhatsApp transcripts, or calls Groq Whisper API if key is configured
   */
  async function transcribeAudioBlob(audioBlob, duration) {
    if (!config.transcribeVoice) return null;

    if (config.groqApiKey && config.groqApiKey.trim()) {
      try {
        const formData = new FormData();
        formData.append('file', audioBlob, 'audio.ogg');
        formData.append('model', 'whisper-large-v3-turbo');

        const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.groqApiKey.trim()}`
          },
          body: formData
        });

        if (response.ok) {
          const json = await response.json();
          if (json.text) return json.text.trim();
        }
      } catch (err) {
        console.warn('Whisper API transcription error:', err);
      }
    }

    return null;
  }

  /**
   * Parse a single message element in the WhatsApp Web DOM
   */
  function parseMessageElement(el) {
    const msgId = el.getAttribute('data-id') || el.id || '';
    const isOutgoing = el.classList.contains('message-out') || (msgId && msgId.startsWith('true_'));

    const copyable = el.querySelector('.copyable-text');
    const prePlainText = copyable?.getAttribute('data-pre-plain-text') || '';

    let timestamp = '';
    let sender = isOutgoing ? 'You' : '';
    let date = '';
    let time = '';

    if (prePlainText) {
      const match = prePlainText.match(/\[(.*?)\]\s*(.*?):\s*$/);
      if (match) {
        timestamp = match[1].trim();
        if (!isOutgoing) sender = match[2].trim();
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

    if (!sender) {
      if (isOutgoing) {
        sender = 'You';
      } else {
        const authorEl = el.querySelector('span[data-testid="author"]');
        sender = authorEl?.innerText || getChatTitle();
      }
    }

    if (!timestamp) {
      const metaEl = el.querySelector('[data-testid="msg-meta"]');
      time = metaEl?.innerText?.replace(/[\r\n\t]/g, ' ').trim() || '';
      timestamp = time;
    }

    // Message text
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

    // Media & Image Tracking
    let mediaType = null;
    let mediaInfo = null;
    let mediaSrc = null;
    let audioSrc = null;
    let transcript = null;

    // Check for Image
    const imgEl = el.querySelector('img[src*="blob:"], [data-testid="image-thumb"] img, img[src*="https://"]');
    if (imgEl && !imgEl.classList.contains('emoji') && !imgEl.closest('[data-testid*="sticker"]')) {
      mediaType = 'Image';
      mediaSrc = imgEl.src;
    }

    // Check for Voice Note / Audio
    const audioPlay = el.querySelector('[data-testid="audio-play"], [data-testid="ptt-play"], audio');
    if (audioPlay) {
      mediaType = 'Voice Note';
      const durEl = el.querySelector('span[data-testid="audio-duration"]');
      mediaInfo = durEl ? durEl.innerText.trim() : '0:15';

      const audioTag = el.querySelector('audio');
      if (audioTag && audioTag.src) audioSrc = audioTag.src;

      // Check for native WhatsApp Web transcript in DOM
      const transcriptEl = el.querySelector(
        '[data-testid="audio-transcript"], .voice-note-transcript, span[data-testid="voice-transcript"]'
      );
      if (transcriptEl) {
        transcript = transcriptEl.innerText.trim();
      }
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
      mediaType = 'Contact Card';
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
      mediaSrc,
      audioSrc,
      transcript,
      reactions
    };
  }

  /**
   * Scrape Chat Messages with Virtual-Scroll Auto Loader
   */
  async function scrapeChat(rangeMode, onProgress = null) {
    if (!isChatOpen()) throw new Error('Please open a WhatsApp chat first!');

    const container = getMessagesScrollContainer();
    const scrapedMap = new Map();
    let targetLimit = Infinity;

    if (rangeMode === 'visible') targetLimit = 0;
    else if (rangeMode === 'all') targetLimit = Infinity;
    else if (!isNaN(parseInt(rangeMode, 10))) targetLimit = parseInt(rangeMode, 10);

    isScrapingActive = true;
    shouldCancelScraping = false;

    let noNewMessagesRounds = 0;
    let prevCount = 0;
    const initialScrollTop = container ? container.scrollTop : 0;

    try {
      while (isScrapingActive && !shouldCancelScraping) {
        const messageElements = document.querySelectorAll(
          '#main div[data-id], #main .message-in, #main .message-out'
        );

        for (const el of messageElements) {
          const msg = parseMessageElement(el);
          if (msg && !scrapedMap.has(msg.id)) {
            scrapedMap.set(msg.id, msg);
          }
        }

        if (onProgress) onProgress(scrapedMap.size);

        if (rangeMode === 'visible' || scrapedMap.size >= targetLimit) break;

        const isSecurityBubblePresent = !!document.querySelector(
          '#main div[data-testid="chat-security-bubble"]'
        );
        const atTop = container && container.scrollTop <= 10;

        if (isSecurityBubblePresent || (atTop && scrapedMap.size === prevCount)) {
          noNewMessagesRounds++;
          if (noNewMessagesRounds >= 3) break;
        } else {
          noNewMessagesRounds = 0;
        }

        prevCount = scrapedMap.size;

        if (container) container.scrollTop = 0;
        await sleep(550);
      }
    } finally {
      isScrapingActive = false;
      if (container && initialScrollTop > 0) container.scrollTop = container.scrollHeight;
    }

    let messages = Array.from(scrapedMap.values());

    if (typeof targetLimit === 'number' && targetLimit > 0 && messages.length > targetLimit) {
      messages = messages.slice(messages.length - targetLimit);
    }

    // Date range filter
    if (config.startDate || config.endDate) {
      const start = config.startDate ? new Date(config.startDate).getTime() : 0;
      const end = config.endDate ? new Date(config.endDate).setHours(23, 59, 59, 999) : Infinity;

      messages = messages.filter((m) => {
        if (!m.date) return true;
        const msgDate = new Date(m.date).getTime();
        if (isNaN(msgDate)) return true;
        return msgDate >= start && msgDate <= end;
      });
    }

    // Process media: fetch image blobs and transcribe voice notes
    let imgCounter = 0;
    for (const msg of messages) {
      if (msg.mediaType === 'Image' && msg.mediaSrc && config.trackImages) {
        imgCounter++;
        msg.mediaFile = `media/image_${imgCounter}.jpg`;
        const fetched = await fetchBlobData(msg.mediaSrc);
        if (fetched) {
          msg.dataUrl = fetched.dataUrl;
          msg.blob = fetched.blob;
        }
      } else if (msg.mediaType === 'Voice Note' && config.transcribeVoice && !msg.transcript && msg.audioSrc) {
        const audioData = await fetchBlobData(msg.audioSrc);
        if (audioData) {
          msg.audioBlob = audioData.blob;
          const tr = await transcribeAudioBlob(audioData.blob, msg.mediaInfo);
          if (tr) msg.transcript = tr;
        }
      }
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
   * Progress Modal
   */
  function showProgressModal(onStopCallback) {
    if (activeProgressElement) activeProgressElement.remove();

    const overlay = document.createElement('div');
    overlay.className = 'swc-modal-overlay';
    overlay.innerHTML = `
      <div class="swc-progress-card">
        <div class="swc-spinner"></div>
        <div>
          <div class="swc-progress-num" id="swcProgressNum">0</div>
          <div style="font-size: 13px; color: var(--swc-text-muted);">Messages Collected So Far</div>
        </div>
        <p style="font-size: 11.5px; color: var(--swc-text-muted); max-width: 250px;">
          Scrolling through WhatsApp Web locally on your device...
        </p>
        <button class="swc-btn-stop" id="swcBtnStop">Stop & Export Now</button>
      </div>
    `;

    document.body.appendChild(overlay);
    activeProgressElement = overlay;

    overlay.querySelector('#swcBtnStop').addEventListener('click', () => {
      shouldCancelScraping = true;
      if (onStopCallback) onStopCallback();
    });

    return {
      updateCount: (num) => {
        const el = overlay.querySelector('#swcProgressNum');
        if (el) el.textContent = num;
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
   * Main Action Executor
   */
  async function performAction(actionType, format = 'md') {
    if (!isChatOpen()) {
      showToast('Please open any WhatsApp chat first!', '⚠️');
      return;
    }

    let progress = null;
    if (config.rangeMode !== 'visible') {
      progress = showProgressModal();
    }

    try {
      const chatData = await scrapeChat(config.rangeMode, (count) => {
        if (progress) progress.updateCount(count);
      });

      if (progress) progress.close();

      if (!chatData.messages || chatData.messages.length === 0) {
        showToast('No messages found to export!', '⚠️');
        return;
      }

      const options = {
        promptType: config.promptType,
        customPrompt: config.customPrompt,
        includeTimestamps: config.includeTimestamps,
        includeSenders: config.includeSenders,
        includeMedia: true,
        includeQuotes: config.includeQuotes,
        includeReactions: config.includeReactions,
        embedImages: config.embedImages
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
          showToast(`Copied ${chatData.messages.length} messages for ChatGPT / Claude!`, '📋');
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
          case 'html': {
            const html = WACopyExporter.toHTML(chatData, options);
            WACopyExporter.downloadFile(html, `${filenameBase}.html`, 'text/html');
            showToast(`Exported as Offline HTML Viewer with images!`, '🌐');
            break;
          }
          case 'pdf': {
            WACopyExporter.printPDF(chatData, options);
            showToast(`Opening Print / PDF dialog...`, '🖨️');
            break;
          }
          case 'zip': {
            showToast('Packaging Chat & Media into ZIP...', '⏳');
            const zipBlob = await WACopyExporter.toZIP(chatData, options);
            WACopyExporter.downloadFile(zipBlob, `${filenameBase}_Bundle.zip`, 'application/zip');
            showToast('ZIP Bundle Downloaded (Chat + Images + Audio)!', '📦');
            break;
          }
          case 'txt': {
            const txt = WACopyExporter.toPlainText(chatData, options);
            WACopyExporter.downloadFile(txt, `${filenameBase}.txt`, 'text/plain');
            showToast(`Exported as Plain Text!`, '📥');
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
        }
      }
    } catch (err) {
      if (progress) progress.close();
      console.error('Simple WhatsApp Copier Error:', err);
      showToast(`Error: ${err.message}`, '❌');
    }
  }

  /**
   * Ultra-Simple In-Page Modal with "Advanced Options" Accordion
   */
  function openMainModal() {
    if (activeModalElement) activeModalElement.remove();

    const title = getChatTitle();
    const visibleCount = document.querySelectorAll('#main div[data-id], #main .message-in, #main .message-out').length;

    const overlay = document.createElement('div');
    overlay.className = 'swc-modal-overlay';
    overlay.id = 'swcMainModal';

    overlay.innerHTML = `
      <div class="swc-modal">
        <!-- Header -->
        <div class="swc-modal-header">
          <div class="swc-brand-box">
            <div class="swc-logo-icon">⚡</div>
            <div>
              <h2>Simple WhatsApp Copier <span class="swc-badge-pro">PRO+ Free</span></h2>
              <p>Tracked Images &bull; Voice Transcripts &bull; Zero Limits</p>
            </div>
          </div>
          <button class="swc-close-btn" id="swcCloseBtn">&times;</button>
        </div>

        <!-- Body -->
        <div class="swc-modal-body">
          <!-- Active Chat Card -->
          <div class="swc-chat-info-card">
            <div class="swc-chat-avatar">${title.charAt(0).toUpperCase()}</div>
            <div style="flex: 1; min-width: 0;">
              <div class="swc-chat-name">${title}</div>
              <div class="swc-chat-sub">~${visibleCount} messages visible in view</div>
            </div>
          </div>

          <!-- PRIMARY ACTION: One-Click AI Copy -->
          <button class="swc-btn-copy-ai" id="swcBtnCopyAI">
            <span class="swc-copy-icon">📋</span>
            <div class="swc-copy-text">
              <strong>Copy Chat for AI (ChatGPT / Claude)</strong>
              <small>One-click clean Markdown to clipboard with tracked images & voice transcripts</small>
            </div>
          </button>

          <!-- Range Quick Selector -->
          <div>
            <span class="swc-section-label">Message Range</span>
            <div class="swc-range-pills" id="swcRangePills">
              <button class="swc-pill-btn" data-val="visible">⚡ Visible</button>
              <button class="swc-pill-btn" data-val="100">100</button>
              <button class="swc-pill-btn active" data-val="500">500</button>
              <button class="swc-pill-btn" data-val="2000">2,000</button>
              <button class="swc-pill-btn" data-val="all">♾️ Entire Chat</button>
            </div>
          </div>

          <!-- PRIMARY EXPORTS: 1-Click Download Buttons -->
          <div>
            <span class="swc-section-label">Download Export</span>
            <div class="swc-export-grid">
              <button class="swc-export-chip" data-fmt="md">
                <span class="fmt-icon">📝</span>
                <span>Markdown</span>
                <span class="fmt-ext">.md</span>
              </button>
              <button class="swc-export-chip" data-fmt="html">
                <span class="fmt-icon">🌐</span>
                <span>HTML Viewer</span>
                <span class="fmt-ext">.html</span>
              </button>
              <button class="swc-export-chip" data-fmt="pdf">
                <span class="fmt-icon">🖨️</span>
                <span>PDF Print</span>
                <span class="fmt-ext">.pdf</span>
              </button>
              <button class="swc-export-chip" data-fmt="zip">
                <span class="fmt-icon">📦</span>
                <span>ZIP (Media)</span>
                <span class="fmt-ext">.zip</span>
              </button>
              <button class="swc-export-chip" data-fmt="txt">
                <span class="fmt-icon">📄</span>
                <span>Plain Text</span>
                <span class="fmt-ext">.txt</span>
              </button>
              <button class="swc-export-chip" data-fmt="csv">
                <span class="fmt-icon">📊</span>
                <span>CSV / Excel</span>
                <span class="fmt-ext">.csv</span>
              </button>
            </div>
          </div>

          <!-- EXPANDABLE: Advanced Options Button -->
          <button class="swc-advanced-toggle-btn" id="swcToggleAdvanced">
            <span>⚙️ Advanced Options (Images, Voice Notes, Prompts, Dates)</span>
            <span id="swcArrow">▾</span>
          </button>

          <!-- ADVANCED DRAWER -->
          <div class="swc-advanced-drawer" id="swcAdvancedDrawer">
            <!-- Images & Media -->
            <div class="swc-drawer-section">
              <div class="swc-drawer-title">🖼️ Images & Media Tracking</div>
              <div class="swc-toggle-row">
                <span>Track & embed images inside chat</span>
                <label class="swc-switch">
                  <input type="checkbox" id="swcOptImages" ${config.trackImages ? 'checked' : ''}>
                  <span class="swc-slider"></span>
                </label>
              </div>
            </div>

            <!-- Voice Notes & AI Transcription -->
            <div class="swc-drawer-section">
              <div class="swc-drawer-title">🎙️ Voice Note Transcription</div>
              <div class="swc-toggle-row">
                <span>Transcribe voice messages & save text</span>
                <label class="swc-switch">
                  <input type="checkbox" id="swcOptVoice" ${config.transcribeVoice ? 'checked' : ''}>
                  <span class="swc-slider"></span>
                </label>
              </div>
              <p style="font-size: 11px; color: var(--swc-warning); margin: 3px 0 6px 0;">
                ⚠️ Note: All transcripts include: "(AI-generated from voice, may contain errors)"
              </p>
              <input type="password" class="swc-input" id="swcGroqKey" placeholder="Optional free Groq/Whisper API key (for instant AI transcription)" value="${config.groqApiKey || ''}" />
            </div>

            <!-- Custom Date Range -->
            <div class="swc-drawer-section">
              <div class="swc-drawer-title">📅 Date Range Filter</div>
              <div class="swc-date-row">
                <input type="date" class="swc-input" id="swcDateStart" placeholder="From Date" value="${config.startDate || ''}" />
                <input type="date" class="swc-input" id="swcDateEnd" placeholder="To Date" value="${config.endDate || ''}" />
              </div>
            </div>

            <!-- AI Prompt Template -->
            <div class="swc-drawer-section">
              <div class="swc-drawer-title">🤖 Prepend AI Prompt</div>
              <select class="swc-input" id="swcPromptSelect">
                <option value="none" ${config.promptType === 'none' ? 'selected' : ''}>No Prompt (Raw Chat)</option>
                <option value="summary" ${config.promptType === 'summary' ? 'selected' : ''}>📝 Summarize discussion & next steps</option>
                <option value="action_items" ${config.promptType === 'action_items' ? 'selected' : ''}>📋 Extract action items & deadlines</option>
                <option value="meeting_notes" ${config.promptType === 'meeting_notes' ? 'selected' : ''}>📑 Convert to formal meeting minutes</option>
                <option value="custom" ${config.promptType === 'custom' ? 'selected' : ''}>✏️ Custom Prompt...</option>
              </select>
              <textarea class="swc-input" id="swcCustomPrompt" style="display: ${config.promptType === 'custom' ? 'block' : 'none'}; height: 50px; margin-top: 4px;" placeholder="Write custom prompt for ChatGPT...">${config.customPrompt || ''}</textarea>
            </div>

            <!-- Metadata Checkboxes -->
            <div class="swc-drawer-section">
              <div class="swc-drawer-title">⚙️ Metadata Formatting</div>
              <div class="swc-toggle-row">
                <span>Include Timestamps</span>
                <label class="swc-switch">
                  <input type="checkbox" id="swcOptTime" ${config.includeTimestamps ? 'checked' : ''}>
                  <span class="swc-slider"></span>
                </label>
              </div>
              <div class="swc-toggle-row">
                <span>Include Sender Names</span>
                <label class="swc-switch">
                  <input type="checkbox" id="swcOptSender" ${config.includeSenders ? 'checked' : ''}>
                  <span class="swc-slider"></span>
                </label>
              </div>
              <div class="swc-toggle-row">
                <span>Include Quoted Replies</span>
                <label class="swc-switch">
                  <input type="checkbox" id="swcOptQuote" ${config.includeQuotes ? 'checked' : ''}>
                  <span class="swc-slider"></span>
                </label>
              </div>
              <div class="swc-toggle-row">
                <span>Include Reactions</span>
                <label class="swc-switch">
                  <input type="checkbox" id="swcOptReact" ${config.includeReactions ? 'checked' : ''}>
                  <span class="swc-slider"></span>
                </label>
              </div>
            </div>

            <!-- Extra Developer Format: JSON -->
            <button class="swc-export-chip" style="flex-direction: row; gap: 8px; width: 100%; padding: 8px;" data-fmt="json">
              <span>🗄️ Download Raw Developer JSON (.json)</span>
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    activeModalElement = overlay;

    // Close events
    overlay.querySelector('#swcCloseBtn').addEventListener('click', () => {
      overlay.remove();
      activeModalElement = null;
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        activeModalElement = null;
      }
    });

    // Toggle Advanced Drawer Accordion
    const advBtn = overlay.querySelector('#swcToggleAdvanced');
    const drawer = overlay.querySelector('#swcAdvancedDrawer');
    const arrow = overlay.querySelector('#swcArrow');
    advBtn.addEventListener('click', () => {
      const isOpen = drawer.classList.toggle('open');
      arrow.textContent = isOpen ? '▴' : '▾';
    });

    // Range pills
    const pills = overlay.querySelectorAll('#swcRangePills .swc-pill-btn');
    pills.forEach((p) => {
      p.addEventListener('click', () => {
        pills.forEach((btn) => btn.classList.remove('active'));
        p.classList.add('active');
        config.rangeMode = p.getAttribute('data-val');
      });
    });

    // Quick AI Copy
    overlay.querySelector('#swcBtnCopyAI').addEventListener('click', () => {
      overlay.remove();
      activeModalElement = null;
      performAction('copy');
    });

    // Export chips (both in primary grid and advanced)
    overlay.querySelectorAll('.swc-export-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fmt = btn.getAttribute('data-fmt');
        overlay.remove();
        activeModalElement = null;
        performAction('export', fmt);
      });
    });

    // Advanced inputs
    const bindCheck = (id, prop) => {
      const el = overlay.querySelector(id);
      if (el) el.addEventListener('change', (e) => (config[prop] = e.target.checked));
    };
    bindCheck('#swcOptImages', 'trackImages');
    bindCheck('#swcOptVoice', 'transcribeVoice');
    bindCheck('#swcOptTime', 'includeTimestamps');
    bindCheck('#swcOptSender', 'includeSenders');
    bindCheck('#swcOptQuote', 'includeQuotes');
    bindCheck('#swcOptReact', 'includeReactions');

    const groqInput = overlay.querySelector('#swcGroqKey');
    groqInput.addEventListener('change', (e) => {
      config.groqApiKey = e.target.value.trim();
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ swc_groq_key: config.groqApiKey });
      }
    });

    const startInput = overlay.querySelector('#swcDateStart');
    const endInput = overlay.querySelector('#swcDateEnd');
    startInput.addEventListener('change', (e) => (config.startDate = e.target.value));
    endInput.addEventListener('change', (e) => (config.endDate = e.target.value));

    const promptSelect = overlay.querySelector('#swcPromptSelect');
    const customPromptArea = overlay.querySelector('#swcCustomPrompt');
    promptSelect.addEventListener('change', (e) => {
      config.promptType = e.target.value;
      customPromptArea.style.display = e.target.value === 'custom' ? 'block' : 'none';
    });
    customPromptArea.addEventListener('input', (e) => (config.customPrompt = e.target.value));
  }

  /**
   * In-Chat Header Button & Floating Widget Injector
   */
  function injectUI() {
    const header = document.querySelector('#main header');
    if (header && !header.querySelector('#swcHeaderBtn')) {
      const headerBtn = document.createElement('button');
      headerBtn.id = 'swcHeaderBtn';
      headerBtn.className = 'swc-header-btn';
      headerBtn.title = 'Simple WhatsApp Copier (PRO+ for free)';
      headerBtn.innerHTML = `
        <svg viewBox="0 0 24 24">
          <path d="M16 1H4C2.9 1 2 1.9 2 3v14h2V3h12V1zm3 4H8C6.9 5 6 5.9 6 7v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
        </svg>
        <span>Copy Chat</span>
      `;
      headerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openMainModal();
      });

      const actionContainer = header.querySelector('div:last-child') || header;
      actionContainer.parentNode.insertBefore(headerBtn, actionContainer);
    }

    if (!document.getElementById('swcFloatingWidget') && document.body) {
      const widget = document.createElement('div');
      widget.id = 'swcFloatingWidget';
      widget.className = 'swc-floating-widget';
      widget.title = 'Simple WhatsApp Copier (PRO+ for free)';
      widget.innerHTML = `
        <span>⚡ Simple Copier</span>
        <span class="swc-badge-pro">PRO+ FREE</span>
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

  const observer = new MutationObserver(() => injectUI());
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(injectUI, 1000);

  // Chrome Extension Messaging
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'GET_STATUS' || request.type === 'wacopy-status') {
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

      if (request.action === 'OPEN_MODAL' || request.type === 'wacopy-toggle') {
        if (!isChatOpen()) {
          showToast('Please open any chat in WhatsApp Web first', '💬');
        } else {
          openMainModal();
        }
        sendResponse({ success: true });
        return true;
      }

      if (request.action === 'TRIGGER_COPY') {
        if (request.config) Object.assign(config, request.config);
        performAction('copy');
        sendResponse({ started: true });
        return true;
      }

      if (request.action === 'TRIGGER_EXPORT') {
        if (request.config) Object.assign(config, request.config);
        performAction('export', request.format || 'md');
        sendResponse({ started: true });
        return true;
      }
    });
  }
})();

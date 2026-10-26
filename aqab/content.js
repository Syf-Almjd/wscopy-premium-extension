/**
 * Simple WhatsApp Copier (PRO+ for free) - Content Script
 * Injected into WhatsApp Web (https://web.whatsapp.com)
 *
 * NOTE: No buttons or floating widgets are injected into WhatsApp Web DOM.
 * All controls are triggered cleanly from the Chrome Extension toolbar popup!
 */

(function () {
  'use strict';

  if (window.__SWC_LOADED__) return;
  window.__SWC_LOADED__ = true;

  console.log('⚡ Simple WhatsApp Copier (PRO+ for free): Content script loaded');

  // State
  let isScrapingActive = false;
  let shouldCancelScraping = false;
  let activeProgressElement = null;

  // Configuration passed from popup
  const currentConfig = {
    rangeMode: '500',
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
    groqApiKey: ''
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Show toast feedback on WhatsApp Web
   */
  function showToast(message, icon = '✅') {
    let toast = document.getElementById('swcToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'swcToast';
      toast.className = 'swc-toast';
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span style="font-size: 18px;">${icon}</span> <span>${message}</span>`;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3500);
  }

  function isChatOpen() {
    const main = document.querySelector('#main');
    if (!main) return false;
    return !!(
      main.querySelector('header') ||
      main.querySelector('[data-testid="conversation-panel-messages"]') ||
      main.querySelector('div[role="application"]') ||
      main.querySelector('.copyable-area') ||
      main.querySelector('footer') ||
      document.querySelector('[data-testid="conversation-info-header"]')
    );
  }

  function getChatTitle() {
    const main = document.querySelector('#main');
    if (!main) return 'WhatsApp Chat';
    const header = main.querySelector('header') || document.querySelector('[data-testid="conversation-info-header"]');
    if (header) {
      const titleSpan =
        header.querySelector('span[dir="auto"][title]') ||
        header.querySelector('span[title]') ||
        header.querySelector('span[dir="auto"]') ||
        header.querySelector('div[role="button"] span');
      const val = titleSpan?.getAttribute('title') || titleSpan?.textContent;
      if (val && val.trim()) return val.trim();
    }
    return 'WhatsApp Chat';
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
   * Helper: Convert dataUrl to Uint8Array bytes
   */
  function dataUrlToBytes(dataUrl) {
    try {
      const base64 = dataUrl.split(',')[1];
      const binStr = atob(base64);
      const len = binStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binStr.charCodeAt(i);
      }
      return bytes;
    } catch (e) {
      return null;
    }
  }

  /**
   * Helper: Fetch Blob URL immediately into memory (bytes & base64 DataURL)
   */
  async function fetchBlobData(blobUrl) {
    if (!blobUrl) return null;
    try {
      // If already a data url
      if (blobUrl.startsWith('data:image')) {
        return {
          dataUrl: blobUrl,
          bytes: dataUrlToBytes(blobUrl),
          mimeType: blobUrl.split(';')[0].replace('data:', '')
        };
      }

      const res = await fetch(blobUrl);
      const blob = await res.blob();
      const arrayBuf = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);

      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          resolve({
            dataUrl: reader.result,
            bytes,
            blob,
            mimeType: blob.type
          });
        };
        reader.onerror = () => resolve({ bytes, blob, mimeType: blob.type });
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      return null;
    }
  }

  /**
   * AI Voice Note Transcriber via Groq Whisper API
   */
  async function transcribeAudioBlob(audioBlob) {
    if (!currentConfig.transcribeVoice) return null;

    if (currentConfig.groqApiKey && currentConfig.groqApiKey.trim()) {
      try {
        const formData = new FormData();
        formData.append('file', audioBlob, 'audio.ogg');
        formData.append('model', 'whisper-large-v3-turbo');

        const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${currentConfig.groqApiKey.trim()}`
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

    // Message Text
    let text = '';
    const textEl = el.querySelector('span.selectable-text, .copyable-text span[dir]');
    if (textEl) {
      text = textEl.innerText.trim();
    }

    // Quoted / Replied message
    let quoted = null;
    const quotedEl = el.querySelector('[data-testid="quoted-message"], [data-testid="quoted-msg"]');
    if (quotedEl) {
      const qSender = quotedEl.querySelector('span[dir="auto"]')?.innerText || 'Reply';
      const qText = quotedEl.innerText.replace(qSender, '').trim();
      quoted = { sender: qSender, text: qText };
    }

    // Media & Image Detection
    let mediaType = null;
    let mediaInfo = null;
    let mediaSrc = null;
    let audioSrc = null;
    let docSrc = null;
    let transcript = null;

    // 1. Image Check
    const imgEl = el.querySelector('img[src*="blob:"], [data-testid="image-thumb"] img, img[src*="https://"], img[src*="data:image"]');
    if (imgEl && !imgEl.classList.contains('emoji') && !imgEl.closest('[data-testid*="sticker"]')) {
      mediaType = 'Image';
      mediaSrc = imgEl.src;
    }

    // Check background-image url if not in img
    if (!mediaType) {
      const bgDiv = el.querySelector('div[style*="background-image"]');
      if (bgDiv) {
        const m = bgDiv.getAttribute('style').match(/background-image:\s*url\(['"]?(.*?)['"]?\)/);
        if (m && m[1] && !m[1].includes('.svg')) {
          mediaType = 'Image';
          mediaSrc = m[1];
        }
      }
    }

    // 2. Voice Note / Audio Check
    const audioPlay = el.querySelector('[data-testid="audio-play"], [data-testid="ptt-play"], audio');
    if (audioPlay) {
      mediaType = 'Voice Note';
      const durEl = el.querySelector('span[data-testid="audio-duration"]');
      mediaInfo = durEl ? durEl.innerText.trim() : '0:15';

      const audioTag = el.querySelector('audio');
      if (audioTag && audioTag.src) audioSrc = audioTag.src;

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
      const docLink = el.querySelector('a[href*="blob:"]');
      if (docLink) docSrc = docLink.href;
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
      docSrc,
      transcript,
      reactions
    };
  }

  /**
   * Scrape Chat Messages & Auto-Scroll
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

            // IMMEDIATELY fetch media blob before element unmounts!
            if (msg.mediaType === 'Image' && msg.mediaSrc && currentConfig.trackImages) {
              fetchBlobData(msg.mediaSrc).then((data) => {
                if (data) {
                  msg.dataUrl = data.dataUrl;
                  msg.imageBytes = data.bytes;
                  msg.mimeType = data.mimeType;
                }
              });
            } else if (msg.mediaType === 'Voice Note' && msg.audioSrc && currentConfig.transcribeVoice) {
              fetchBlobData(msg.audioSrc).then((data) => {
                if (data) {
                  msg.audioBytes = data.bytes;
                  if (!msg.transcript) {
                    transcribeAudioBlob(data.blob).then((tr) => {
                      if (tr) msg.transcript = tr;
                    });
                  }
                }
              });
            } else if (msg.mediaType === 'Document' && msg.docSrc) {
              fetchBlobData(msg.docSrc).then((data) => {
                if (data) msg.docBytes = data.bytes;
              });
            }
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
    if (currentConfig.startDate || currentConfig.endDate) {
      const start = currentConfig.startDate ? new Date(currentConfig.startDate).getTime() : 0;
      const end = currentConfig.endDate ? new Date(currentConfig.endDate).setHours(23, 59, 59, 999) : Infinity;

      messages = messages.filter((m) => {
        if (!m.date) return true;
        const msgDate = new Date(m.date).getTime();
        if (isNaN(msgDate)) return true;
        return msgDate >= start && msgDate <= end;
      });
    }

    // Wait a brief moment to ensure in-flight media fetches resolve
    await sleep(400);

    // Number images sequentially for media links
    let imgCounter = 0;
    let voiceCounter = 0;
    for (const m of messages) {
      if (m.mediaType === 'Image') {
        imgCounter++;
        const ext = m.mimeType?.includes('png') ? 'png' : m.mimeType?.includes('webp') ? 'webp' : 'jpg';
        m.mediaFile = `media/image_${imgCounter}.${ext}`;
      } else if (m.mediaType === 'Voice Note') {
        voiceCounter++;
        m.mediaFile = `media/voice_note_${voiceCounter}.ogg`;
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
   * Progress Modal (Shows while virtual scrolling)
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
   * Main Action Handler
   */
  async function performAction(actionType, format = 'md') {
    if (!isChatOpen()) {
      showToast('Please open any WhatsApp chat first!', '⚠️');
      return;
    }

    let progress = null;
    if (currentConfig.rangeMode !== 'visible') {
      progress = showProgressModal();
    }

    try {
      const chatData = await scrapeChat(currentConfig.rangeMode, (count) => {
        if (progress) progress.updateCount(count);
      });

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
        includeMedia: true,
        includeQuotes: currentConfig.includeQuotes,
        includeReactions: currentConfig.includeReactions,
        embedImages: currentConfig.embedImages
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
          case 'zip': {
            showToast('Packaging Chat & all Media files into ZIP...', '⏳');
            const zipBlob = await WACopyExporter.toZIP(chatData, options);
            WACopyExporter.downloadFile(zipBlob, `${filenameBase}_Bundle.zip`, 'application/zip');
            showToast(`Downloaded ZIP Bundle (${chatData.messages.length} msgs + media)!`, '📦');
            break;
          }
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

  // Chrome Extension Messaging
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'PING') {
        sendResponse({ pong: true });
        return true;
      }

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

      if (request.action === 'TRIGGER_COPY') {
        if (request.config) Object.assign(currentConfig, request.config);
        performAction('copy');
        sendResponse({ started: true });
        return true;
      }

      if (request.action === 'TRIGGER_EXPORT') {
        if (request.config) Object.assign(currentConfig, request.config);
        performAction('export', request.format || 'zip');
        sendResponse({ started: true });
        return true;
      }
    });
  }
})();

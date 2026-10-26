/**
 * WS Copy & Export (PRO+ for free) - Content Script
 * Injected into WhatsApp Web (https://web.whatsapp.com)
 *
 * Captures all chat messages, tracked images, full documents (PDFs, Word, Excel, etc.),
 * voice note transcripts, and formats them for 1-click AI copy or ZIP export.
 */

(function () {
  'use strict';

  if (window.__SWC_LOADED__) return;
  window.__SWC_LOADED__ = true;

  console.log('⚡ WS Copy & Export (PRO+ for free): Content script ready');

  // State
  let isScrapingActive = false;
  let shouldCancelScraping = false;
  let activeProgressElement = null;

  // Intercepted documents registry: key (filename or url) -> { filename, bytes, blob, url, timestamp }
  const capturedDocsMap = new Map();
  const allCapturedBlobs = [];
  const docResolveListeners = new Set();

  /**
   * Listen for documents and blobs intercepted by interceptor.js in the main world
   */
  window.addEventListener('message', async (e) => {
    if (!e.data || typeof e.data !== 'object') return;

    // 1. Captured document download intent (filename + url)
    if (e.data.type === 'SWC_DOCUMENT_INTERCEPTED') {
      const { filename, url } = e.data;
      if (!url) return;

      try {
        const res = await fetch(url);
        const blob = await res.blob();
        const arrayBuf = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuf);
        const entry = {
          filename: filename || 'document.pdf',
          bytes,
          blob,
          url,
          timestamp: Date.now()
        };

        if (filename) {
          capturedDocsMap.set(filename.trim().toLowerCase(), entry);
        }
        capturedDocsMap.set(url, entry);
        allCapturedBlobs.push(entry);

        console.log('⚡ SWC: Intercepted & cached document:', filename, bytes.length, 'bytes');
        docResolveListeners.forEach((fn) => fn(entry));
      } catch (err) {
        console.warn('SWC: Could not fetch intercepted document URL:', err);
      }
    }
    // 2. Captured blob created via URL.createObjectURL
    else if (e.data.type === 'SWC_BLOB_CREATED') {
      const { url, mimeType, size } = e.data;
      if (!url) return;

      // Only fetch if it might be a document or media
      const isDocType =
        mimeType &&
        (mimeType.includes('pdf') ||
          mimeType.includes('word') ||
          mimeType.includes('officedocument') ||
          mimeType.includes('excel') ||
          mimeType.includes('sheet') ||
          mimeType.includes('powerpoint') ||
          mimeType.includes('presentation') ||
          mimeType.includes('zip') ||
          mimeType.includes('tar') ||
          mimeType.includes('text/plain') ||
          mimeType.includes('csv') ||
          mimeType.includes('octet-stream'));

      if (isDocType || size > 10240) {
        try {
          const res = await fetch(url);
          const blob = await res.blob();
          const arrayBuf = await blob.arrayBuffer();
          const bytes = new Uint8Array(arrayBuf);
          const entry = {
            filename: '',
            bytes,
            blob,
            url,
            mimeType,
            size,
            timestamp: Date.now()
          };
          capturedDocsMap.set(url, entry);
          allCapturedBlobs.push(entry);
          docResolveListeners.forEach((fn) => fn(entry));
        } catch (err) { }
      }
    }
  });

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
   * Simulate trusted click on DOM element to trigger React synthetic events
   */
  function simulateClick(el) {
    if (!el) return;
    ['mousedown', 'mouseup', 'click'].forEach((type) => {
      el.dispatchEvent(new MouseEvent(type, { view: window, bubbles: true, cancelable: true, buttons: 1 }));
    });
    if (typeof el.click === 'function') {
      try {
        el.click();
      } catch (e) { }
    }
  }

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
    setTimeout(() => toast.classList.remove('show'), 3800);
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
      if (blobUrl.startsWith('data:image') || blobUrl.startsWith('data:application')) {
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
   * Comprehensive Document & File Detector (PDF, Word, Excel, ZIP, etc.)
   */
  function detectDocument(el) {
    // 1. Icon check
    const docIcon = el.querySelector(
      '[data-icon*="doc"], [data-icon="document"], [data-testid="document-thumb"], [data-testid*="doc"], [data-icon="doc-pdf"], [data-icon="doc-word"], [data-icon="doc-excel"], [data-icon="doc-ppt"], [data-icon="doc-generic"], [data-icon="doc-zip"], [data-icon="audio-file"], [data-icon="audio-download"]'
    );

    // 2. Metadata pattern in innerText (e.g. "2 pages • 145 kB • pdf" or "1.2 MB • docx")
    const elText = el.innerText || '';
    const metaMatch = elText.match(/\b(\d+(?:\.\d+)?\s*(?:kB|MB|GB|B))\s*•\s*([a-z0-9]{2,5})\b/i);

    let filename = '';
    const extRegex = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|txt|csv|rtf|epub|odt|ods|odp|pages|numbers|key|mp3|wav|ogg|apk)$/i;

    // Scan title attributes
    const titleNodes = el.querySelectorAll('span[title], div[title], a[title]');
    for (const node of titleNodes) {
      const t = (node.getAttribute('title') || '').trim();
      if (extRegex.test(t)) {
        filename = t;
        break;
      }
    }

    // Scan text nodes
    if (!filename) {
      const textNodes = el.querySelectorAll('span[dir="auto"], span.selectable-text, .copyable-text span, div[role="button"] span');
      for (const t of textNodes) {
        const txt = (t.textContent || t.innerText || '').trim();
        if (extRegex.test(txt) && txt.length < 250) {
          filename = txt;
          break;
        }
      }
    }

    // If icon or metadata indicates a document
    if (docIcon || metaMatch || extRegex.test(filename)) {
      let sizeText = '';
      if (metaMatch) {
        sizeText = metaMatch[1];
      } else {
        const sizeMatch = elText.match(/\b\d+(\.\d+)?\s*(kB|MB|GB|B)\b/i);
        if (sizeMatch) sizeText = sizeMatch[0];
      }

      const detectedExt = metaMatch ? metaMatch[2].toLowerCase() : 'pdf';
      if (!filename) {
        filename = `document.${detectedExt}`;
      } else if (!filename.includes('.')) {
        filename = `${filename}.${detectedExt}`;
      }

      return {
        filename,
        sizeText,
        detectedExt
      };
    }

    return null;
  }

  /**
   * Helper: Locate document download button or card trigger inside a message element
   */
  function getDocumentDownloadTrigger(el) {
    if (!el) return null;
    const dlIcon = el.querySelector(
      'span[data-icon="download"], span[data-icon="document-download"], [data-testid="document-download"], span[data-icon="audio-download"]'
    );
    if (dlIcon) {
      return dlIcon.closest('button, [role="button"]') || dlIcon;
    }

    const docCard =
      el.querySelector('[data-testid="document-thumb"]')?.closest('[role="button"]') ||
      el.querySelector('div[role="button"][title]');
    if (docCard) return docCard;

    return null;
  }

  /**
   * Fetch Document bytes (from cache, direct blob, or triggering download)
   */
  async function fetchDocumentBytes(msg, el, timeoutMs = 3800) {
    if (msg.docBytes && msg.docBytes.length > 0) return msg.docBytes;

    const key = (msg.mediaInfo || '').trim().toLowerCase();

    // 1. Check in-memory map
    let cached = capturedDocsMap.get(key);
    if (cached && cached.bytes) {
      msg.docBytes = cached.bytes;
      msg.docBlob = cached.blob;
      return cached.bytes;
    }

    // 2. Check for anchor tag with blob url
    const blobLink = el?.querySelector('a[href*="blob:"]');
    if (blobLink && blobLink.href) {
      const data = await fetchBlobData(blobLink.href);
      if (data && data.bytes) {
        msg.docBytes = data.bytes;
        msg.docBlob = data.blob;
        capturedDocsMap.set(key, { filename: msg.mediaInfo, bytes: data.bytes, blob: data.blob, url: blobLink.href });
        return data.bytes;
      }
    }

    // 3. Trigger download via DOM element
    const trigger = getDocumentDownloadTrigger(el);
    if (trigger) {
      simulateClick(trigger);

      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        await sleep(150);
        cached = capturedDocsMap.get(key);
        if (cached && cached.bytes) {
          msg.docBytes = cached.bytes;
          msg.docBlob = cached.blob;
          return cached.bytes;
        }

        // Check recent blobs
        if (allCapturedBlobs.length > 0) {
          const last = allCapturedBlobs[allCapturedBlobs.length - 1];
          if (last && !last.assigned && Date.now() - last.timestamp < timeoutMs && last.bytes) {
            last.assigned = true;
            msg.docBytes = last.bytes;
            msg.docBlob = last.blob;
            capturedDocsMap.set(key, last);
            return last.bytes;
          }
        }
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

    // Media, Document & Image Detection
    let mediaType = null;
    let mediaInfo = null;
    let mediaSrc = null;
    let audioSrc = null;
    let docBytes = null;
    let docBlob = null;
    let fileSize = null;
    let transcript = null;

    // 1. Document Check (PDF, Word, Excel, ZIP, etc.)
    const docInfo = detectDocument(el);
    if (docInfo) {
      mediaType = 'Document';
      mediaInfo = docInfo.filename;
      fileSize = docInfo.sizeText;

      const cached = capturedDocsMap.get(docInfo.filename.toLowerCase());
      if (cached) {
        docBytes = cached.bytes;
        docBlob = cached.blob;
      }
    }

    // 2. Image Check
    if (!mediaType) {
      const imgEl = el.querySelector('img[src*="blob:"], [data-testid="image-thumb"] img, img[src*="https://"], img[src*="data:image"]');
      if (imgEl && !imgEl.classList.contains('emoji') && !imgEl.closest('[data-testid*="sticker"]')) {
        mediaType = 'Image';
        mediaSrc = imgEl.src;
      }

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
    }

    // 3. Voice Note / Audio Check
    if (!mediaType) {
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
      } else if (el.querySelector('[data-testid="sticker"]')) {
        mediaType = 'Sticker';
      } else if (el.querySelector('[data-testid="location"]')) {
        mediaType = 'Location';
      } else if (el.querySelector('[data-testid="vcard"]')) {
        mediaType = 'Contact Card';
      }
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
      fileSize,
      mediaSrc,
      audioSrc,
      docBytes,
      docBlob,
      transcript,
      reactions,
      _domElement: el
    };
  }

  /**
   * Scrape Chat Messages & Auto-Scroll
   */
  async function scrapeChat(rangeMode, onProgress = null) {
    if (!isChatOpen()) throw new Error('Please open a WhatsApp chat first!');

    // Enable download suppression in main world so batch document clicks don't spam browser Downloads
    window.postMessage({ type: 'SWC_SET_SUPPRESS_DOWNLOAD', suppress: true }, '*');

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

            // 1. Immediately fetch Image blob
            if (msg.mediaType === 'Image' && msg.mediaSrc && currentConfig.trackImages) {
              fetchBlobData(msg.mediaSrc).then((data) => {
                if (data) {
                  msg.dataUrl = data.dataUrl;
                  msg.imageBytes = data.bytes;
                  msg.mimeType = data.mimeType;
                }
              });
            }
            // 2. Immediately fetch Voice Note blob
            else if (msg.mediaType === 'Voice Note' && msg.audioSrc && currentConfig.transcribeVoice) {
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
            }
            // 3. Immediately trigger Document fetch while mounted in DOM
            else if (msg.mediaType === 'Document' && !msg.docBytes) {
              fetchDocumentBytes(msg, el);
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

    // Wait for in-flight document downloads to complete
    const pendingDocs = messages.filter((m) => m.mediaType === 'Document' && !m.docBytes);
    if (pendingDocs.length > 0) {
      const waitStart = Date.now();
      while (Date.now() - waitStart < 2500) {
        let missingCount = 0;
        for (const doc of pendingDocs) {
          const key = (doc.mediaInfo || '').trim().toLowerCase();
          const cached = capturedDocsMap.get(key);
          if (cached && cached.bytes) {
            doc.docBytes = cached.bytes;
            doc.docBlob = cached.blob;
          } else {
            missingCount++;
          }
        }
        if (missingCount === 0) break;
        await sleep(200);
      }
    }

    // Restore native download behavior
    window.postMessage({ type: 'SWC_SET_SUPPRESS_DOWNLOAD', suppress: false }, '*');

    // Number images & voice notes and link captured document bytes
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
      } else if (m.mediaType === 'Document' && m.mediaInfo) {
        const cached = capturedDocsMap.get(m.mediaInfo.trim().toLowerCase());
        if (cached && cached.bytes) {
          m.docBytes = cached.bytes;
          m.docBlob = cached.blob;
        }
        const cleanName = m.mediaInfo.replace(/[^a-zA-Z0-9._-]/g, '_');
        m.mediaFile = `media/${cleanName}`;
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
   * Progress Modal (Shows while virtual scrolling & downloading media)
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
          <div style="font-size: 13px; color: var(--swc-text-muted);" id="swcProgressLabel">Messages Collected</div>
        </div>
        <p style="font-size: 11.5px; color: var(--swc-text-muted); max-width: 250px;">
          Scrolling through WhatsApp Web & loading media locally on your device...
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
      updateCount: (num, label) => {
        const elNum = overlay.querySelector('#swcProgressNum');
        if (elNum) elNum.textContent = num;
        if (label) {
          const elLabel = overlay.querySelector('#swcProgressLabel');
          if (elLabel) elLabel.textContent = label;
        }
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
      const chatData = await scrapeChat(currentConfig.rangeMode, (count, label) => {
        if (progress) progress.updateCount(count, label);
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
            showToast('Packaging Chat & all Media/Files into ZIP...', '⏳');
            const zipBlob = await WACopyExporter.toZIP(chatData, options);
            WACopyExporter.downloadFile(zipBlob, `${filenameBase}_Bundle.zip`, 'application/zip');
            showToast(`Downloaded ZIP Bundle (${chatData.messages.length} msgs + files)!`, '📦');
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
            showToast(`Exported as Offline HTML Viewer!`, '🌐');
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
      console.error('WS Copy & Export Error:', err);
      showToast(`Error: ${err.message}`, '❌');
    } finally {
      window.postMessage({ type: 'SWC_SET_SUPPRESS_DOWNLOAD', suppress: false }, '*');
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

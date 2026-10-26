/**
 * WS Copy & Export (PRO+ for free) - Main World Interceptor
 * Injected into the page's MAIN context (https://web.whatsapp.com)
 *
 * Responsibilities:
 * 1. Hooks URL.createObjectURL to capture decrypted media & document blobs in memory
 * 2. Delays URL.revokeObjectURL so content scripts have time to fetch blobs
 * 3. Hooks HTMLAnchorElement.prototype.click & dispatchEvent to intercept document downloads
 * 4. Suppresses individual browser download prompts during batch ZIP export
 * 5. Communicates with isolated content script via window.postMessage
 */

(function () {
  'use strict';

  if (window.__SWC_INTERCEPTOR_LOADED__) return;
  window.__SWC_INTERCEPTOR_LOADED__ = true;

  console.log('⚡ WS Copy & Export: Main-world interceptor active');

  // Registry of created blobs: url -> { blob, size, type, timestamp }
  window.__swcCreatedBlobs = window.__swcCreatedBlobs || new Map();
  // Suppression flag: when true, extension is exporting and suppresses native single-file downloads
  window.__swcSuppressDownload = false;

  // 1. Intercept URL.createObjectURL
  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (blob) {
    const url = origCreateObjectURL.call(URL, blob);
    try {
      if (blob && (blob.size || blob.type)) {
        window.__swcCreatedBlobs.set(url, {
          blob: blob,
          size: blob.size || 0,
          type: blob.type || 'application/octet-stream',
          timestamp: Date.now()
        });

        // Notify content script
        window.postMessage(
          {
            type: 'SWC_BLOB_CREATED',
            url: url,
            size: blob.size || 0,
            mimeType: blob.type || 'application/octet-stream'
          },
          '*'
        );
      }
    } catch (e) {
      console.warn('SWC: createObjectURL error:', e);
    }
    return url;
  };

  // 2. Intercept URL.revokeObjectURL to delay revocation
  // WhatsApp Web often immediately revokes document blob URLs after triggering download;
  // delaying revocation by 60 seconds guarantees content script can fetch the binary data.
  const origRevokeObjectURL = URL.revokeObjectURL;
  URL.revokeObjectURL = function (url) {
    setTimeout(() => {
      try {
        origRevokeObjectURL.call(URL, url);
      } catch (e) { }
    }, 60000);
  };

  /**
   * Helper to inspect anchor download intent
   */
  function handleDownloadAnchor(anchor, isMethodClick) {
    try {
      const filename = anchor.download || anchor.getAttribute('download') || '';
      const href = anchor.href || anchor.getAttribute('href') || '';

      if (href) {
        window.postMessage(
          {
            type: 'SWC_DOCUMENT_INTERCEPTED',
            filename: filename,
            url: href,
            isMethodClick: !!isMethodClick
          },
          '*'
        );

        if (window.__swcSuppressDownload) {
          // Suppress native download prompt during batch ZIP packaging
          return true;
        }
      }
    } catch (e) {
      console.warn('SWC: handleDownloadAnchor error:', e);
    }
    return false;
  }

  // 3. Intercept HTMLAnchorElement.prototype.click
  const origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const suppressed = handleDownloadAnchor(this, true);
    if (suppressed) {
      return; // Do not trigger browser download dialog
    }
    return origAnchorClick.apply(this, arguments);
  };

  // 4. Intercept EventTarget.prototype.dispatchEvent for programmatic clicks
  const origDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event) {
    if (this instanceof HTMLAnchorElement && event && (event.type === 'click' || event.type === 'pointerdown')) {
      const suppressed = handleDownloadAnchor(this, false);
      if (suppressed) {
        return false;
      }
    }
    return origDispatch.apply(this, arguments);
  };

  // 5. Intercept window.open
  const origWindowOpen = window.open;
  window.open = function (url) {
    if (typeof url === 'string' && url.startsWith('blob:')) {
      window.postMessage(
        {
          type: 'SWC_DOCUMENT_INTERCEPTED',
          filename: '',
          url: url
        },
        '*'
      );
      if (window.__swcSuppressDownload) {
        return { closed: false, focus: () => { } };
      }
    }
    return origWindowOpen.apply(this, arguments);
  };

  // 6. Handle bidirectional messages from isolated content script
  window.addEventListener('message', async (e) => {
    if (!e.data || typeof e.data !== 'object') return;

    if (e.data.type === 'SWC_PING') {
      window.postMessage({ type: 'SWC_PONG' }, '*');
    } else if (e.data.type === 'SWC_SET_SUPPRESS_DOWNLOAD') {
      window.__swcSuppressDownload = !!e.data.suppress;
    } else if (e.data.type === 'SWC_REQUEST_BLOB') {
      const entry = window.__swcCreatedBlobs.get(e.data.url);
      if (entry && entry.blob) {
        try {
          const buf = await entry.blob.arrayBuffer();
          window.postMessage(
            {
              type: 'SWC_BLOB_RESPONSE',
              requestId: e.data.requestId,
              url: e.data.url,
              buffer: buf,
              mimeType: entry.type,
              size: entry.size
            },
            '*',
            [buf]
          );
        } catch (err) { }
      }
    }
  });
})();

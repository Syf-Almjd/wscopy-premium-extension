/**
 * WACopy Pro - Exporter Module
 * Handles formatting WhatsApp chats into Markdown, Plain Text, HTML, CSV, JSON, and PDF
 */

const WACopyExporter = (function () {
  'use strict';

  // AI Prompt templates
  const AI_PROMPTS = {
    none: '',
    summary:
      'Please analyze and summarize the following WhatsApp conversation. Highlight key topics, agreements reached, unresolved questions, and next steps.\n\n---\n\n',
    action_items:
      'Extract all action items, tasks, deadlines, and assignees from this WhatsApp conversation into a prioritized bulleted list.\n\n---\n\n',
    meeting_notes:
      'Convert this WhatsApp chat transcript into structured meeting minutes with attendees, main discussion points, decisions made, and follow-up tasks.\n\n---\n\n',
    qa_insights:
      'Review this WhatsApp conversation and extract the most valuable insights, answers given, and reference links shared.\n\n---\n\n',
    sentiment:
      'Analyze the tone, sentiment, and relationship dynamics in this WhatsApp conversation. Note any escalation, agreement, or consensus.\n\n---\n\n'
  };

  /**
   * Escape CSV field per RFC 4180
   */
  function escapeCSV(field) {
    if (field === null || field === undefined) return '""';
    const str = String(field);
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return `"${str}"`;
  }

  /**
   * Format chat data to Markdown (.md)
   */
  function toMarkdown(chatData, options = {}) {
    const {
      promptType = 'none',
      customPrompt = '',
      includeTimestamps = true,
      includeSenders = true,
      includeMedia = true,
      includeQuotes = true,
      includeReactions = true
    } = options;

    let output = '';

    // Prepend AI prompt if selected
    if (promptType === 'custom' && customPrompt.trim()) {
      output += `${customPrompt.trim()}\n\n---\n\n`;
    } else if (AI_PROMPTS[promptType]) {
      output += AI_PROMPTS[promptType];
    }

    // Chat Header
    output += `# WhatsApp Chat: ${chatData.chatTitle || 'Conversation'}\n\n`;
    output += `- **Total Messages:** ${chatData.messages.length}\n`;
    if (chatData.dateRange?.start && chatData.dateRange?.end) {
      output += `- **Date Range:** ${chatData.dateRange.start} — ${chatData.dateRange.end}\n`;
    }
    output += `- **Exported At:** ${new Date().toLocaleString()}\n`;
    output += `- **Exported with:** WACopy Pro (Free Edition)\n\n`;
    output += `---\n\n`;

    for (const msg of chatData.messages) {
      let line = '';

      if (includeTimestamps && msg.timestamp) {
        line += `[${msg.timestamp}] `;
      }

      if (includeSenders) {
        const sender = msg.isOutgoing ? 'You' : (msg.sender || 'Unknown');
        line += `**${sender}**: `;
      }

      // Handle Quoted message
      if (includeQuotes && msg.quoted) {
        line += `\n> ↩️ **${msg.quoted.sender || 'Quote'}**: ${msg.quoted.text.replace(/\n/g, ' ')}\n> \n`;
        if (includeTimestamps && msg.timestamp) line += `[${msg.timestamp}] `;
        if (includeSenders) line += `**${msg.isOutgoing ? 'You' : (msg.sender || 'Unknown')}**: `;
      }

      // Main message text
      let bodyText = msg.text || '';

      // Media indicator
      if (includeMedia && msg.mediaType) {
        const mediaTag = `*[${msg.mediaType}${msg.mediaInfo ? ': ' + msg.mediaInfo : ''}]*`;
        bodyText = bodyText ? `${mediaTag} ${bodyText}` : mediaTag;
      }

      line += bodyText || '*(empty message)*';

      // Reactions
      if (includeReactions && msg.reactions && msg.reactions.length > 0) {
        line += `  *(Reactions: ${msg.reactions.join(' ')})*`;
      }

      output += `${line}\n\n`;
    }

    return output;
  }

  /**
   * Format chat data to Plain Text (.txt)
   */
  function toPlainText(chatData, options = {}) {
    const {
      includeTimestamps = true,
      includeSenders = true,
      includeMedia = true,
      includeQuotes = true,
      includeReactions = true
    } = options;

    let output = `WhatsApp Chat History: ${chatData.chatTitle || 'Conversation'}\n`;
    output += `Exported: ${new Date().toLocaleString()}\n`;
    output += `Total Messages: ${chatData.messages.length}\n`;
    output += `=======================================================\n\n`;

    for (const msg of chatData.messages) {
      let line = '';

      if (includeTimestamps && msg.timestamp) {
        line += `[${msg.timestamp}] `;
      }

      if (includeSenders) {
        const sender = msg.isOutgoing ? 'You' : (msg.sender || 'Unknown');
        line += `${sender}: `;
      }

      if (includeQuotes && msg.quoted) {
        line += `[Quoting ${msg.quoted.sender || 'User'}: "${msg.quoted.text.replace(/\n/g, ' ')}"] `;
      }

      let body = msg.text || '';
      if (includeMedia && msg.mediaType) {
        const media = `<${msg.mediaType}${msg.mediaInfo ? ': ' + msg.mediaInfo : ''}>`;
        body = body ? `${media} ${body}` : media;
      }

      line += body || '<empty>';

      if (includeReactions && msg.reactions && msg.reactions.length > 0) {
        line += ` {Reactions: ${msg.reactions.join(' ')}}`;
      }

      output += `${line}\n`;
    }

    return output;
  }

  /**
   * Format chat data to CSV (.csv)
   */
  function toCSV(chatData, options = {}) {
    const headers = [
      'id',
      'timestamp',
      'date',
      'time',
      'sender',
      'direction',
      'message',
      'reply_to_sender',
      'reply_to_text',
      'media_type',
      'reactions'
    ];

    let csv = headers.map(escapeCSV).join(',') + '\r\n';

    for (const msg of chatData.messages) {
      const row = [
        msg.id || '',
        msg.timestamp || '',
        msg.date || '',
        msg.time || '',
        msg.isOutgoing ? 'You' : (msg.sender || ''),
        msg.isOutgoing ? 'Outgoing' : 'Incoming',
        msg.text || '',
        msg.quoted?.sender || '',
        msg.quoted?.text || '',
        msg.mediaType || '',
        msg.reactions ? msg.reactions.join(' ') : ''
      ];
      csv += row.map(escapeCSV).join(',') + '\r\n';
    }

    return csv;
  }

  /**
   * Format chat data to JSON (.json)
   */
  function toJSON(chatData, options = {}) {
    const exportObject = {
      exportMetadata: {
        tool: 'WACopy Pro',
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        chatTitle: chatData.chatTitle || 'Unknown Chat',
        totalMessages: chatData.messages.length,
        dateRange: chatData.dateRange || null
      },
      messages: chatData.messages.map((m) => ({
        id: m.id || null,
        timestamp: m.timestamp || null,
        date: m.date || null,
        time: m.time || null,
        sender: m.isOutgoing ? 'You' : (m.sender || 'Unknown'),
        isOutgoing: !!m.isOutgoing,
        text: m.text || '',
        quoted: m.quoted || null,
        mediaType: m.mediaType || null,
        mediaInfo: m.mediaInfo || null,
        reactions: m.reactions || []
      }))
    };

    return JSON.stringify(exportObject, null, 2);
  }

  /**
   * Format chat data into a standalone, interactive, beautiful HTML viewer with dark/light mode and search
   */
  function toHTML(chatData, options = {}) {
    const title = escapeHtml(chatData.chatTitle || 'WhatsApp Chat');
    const total = chatData.messages.length;
    const dateRangeStr =
      chatData.dateRange?.start && chatData.dateRange?.end
        ? `${escapeHtml(chatData.dateRange.start)} — ${escapeHtml(chatData.dateRange.end)}`
        : 'All History';

    // Unique senders for filtering
    const senders = new Set();
    chatData.messages.forEach((m) => {
      senders.add(m.isOutgoing ? 'You' : (m.sender || 'Unknown'));
    });
    const senderOptions = Array.from(senders)
      .map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
      .join('');

    // Generate message items HTML
    const messagesHtml = chatData.messages
      .map((m, idx) => {
        const isOut = m.isOutgoing;
        const senderName = isOut ? 'You' : (m.sender || 'Unknown');
        const bubbleClass = isOut ? 'msg-out' : 'msg-in';
        const timestamp = m.timestamp ? escapeHtml(m.timestamp) : '';
        const timeOnly = m.time ? escapeHtml(m.time) : timestamp;

        let quotedHtml = '';
        if (m.quoted) {
          quotedHtml = `
            <div class="msg-quote">
              <span class="quote-sender">${escapeHtml(m.quoted.sender || 'Reply')}</span>
              <span class="quote-text">${escapeHtml(m.quoted.text || '')}</span>
            </div>
          `;
        }

        let mediaHtml = '';
        if (m.mediaType) {
          let mediaIcon = '📎';
          if (m.mediaType.includes('Image')) mediaIcon = '🖼️';
          else if (m.mediaType.includes('Voice') || m.mediaType.includes('Audio')) mediaIcon = '🎙️';
          else if (m.mediaType.includes('Video')) mediaIcon = '🎥';
          else if (m.mediaType.includes('Document')) mediaIcon = '📄';
          else if (m.mediaType.includes('Sticker')) mediaIcon = '✨';
          else if (m.mediaType.includes('Location')) mediaIcon = '📍';

          mediaHtml = `
            <div class="msg-media-badge">
              <span class="media-icon">${mediaIcon}</span>
              <span class="media-label">${escapeHtml(m.mediaType)}</span>
              ${m.mediaInfo ? `<span class="media-info">${escapeHtml(m.mediaInfo)}</span>` : ''}
            </div>
          `;
        }

        let textHtml = '';
        if (m.text) {
          textHtml = `<div class="msg-text">${escapeHtml(m.text).replace(/\n/g, '<br>')}</div>`;
        }

        let reactionsHtml = '';
        if (m.reactions && m.reactions.length > 0) {
          reactionsHtml = `
            <div class="msg-reactions">
              ${m.reactions.map((r) => `<span class="reaction-item">${escapeHtml(r)}</span>`).join('')}
            </div>
          `;
        }

        return `
          <div class="msg-row ${bubbleClass}" data-sender="${escapeHtml(senderName)}" data-index="${idx}">
            <div class="msg-bubble">
              ${!isOut ? `<div class="msg-sender">${escapeHtml(senderName)}</div>` : ''}
              ${quotedHtml}
              ${mediaHtml}
              ${textHtml}
              <div class="msg-footer">
                <span class="msg-time" title="${timestamp}">${timeOnly}</span>
                ${isOut ? '<span class="msg-status">✓✓</span>' : ''}
              </div>
              ${reactionsHtml}
            </div>
          </div>
        `;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Chat - ${title}</title>
  <style>
    :root {
      --bg-page: #eae6df;
      --bg-chat: #efeae2;
      --header-bg: #f0f2f5;
      --text-primary: #111b21;
      --text-secondary: #667781;
      --border-color: #e9edef;
      --bubble-out: #d9fdd3;
      --bubble-in: #ffffff;
      --quote-border: #25d366;
      --quote-bg: rgba(0, 0, 0, 0.05);
      --accent: #00a884;
      --accent-hover: #06cf9c;
      --shadow: 0 1px 0.5px rgba(11, 20, 26, 0.13);
    }

    [data-theme="dark"] {
      --bg-page: #0c1317;
      --bg-chat: #0b141a;
      --header-bg: #202c33;
      --text-primary: #e9edef;
      --text-secondary: #8696a0;
      --border-color: #2a3942;
      --bubble-out: #005c4b;
      --bubble-in: #202c33;
      --quote-border: #00a884;
      --quote-bg: rgba(255, 255, 255, 0.05);
      --accent: #00a884;
      --accent-hover: #06cf9c;
      --shadow: 0 1px 0.5px rgba(0, 0, 0, 0.3);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg-page);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .app-container {
      width: 100%;
      max-width: 900px;
      margin: 20px auto;
      background: var(--bg-chat);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
      display: flex;
      flex-direction: column;
      min-height: calc(100vh - 40px);
    }

    .app-header {
      background: var(--header-bg);
      padding: 14px 20px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .header-info {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .chat-avatar {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: var(--accent);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      font-weight: 600;
    }

    .header-titles h1 {
      font-size: 17px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .header-titles p {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 2px;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .action-btn {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 7px 12px;
      border-radius: 8px;
      font-size: 13px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 500;
      transition: all 0.2s;
    }

    .action-btn:hover {
      background: rgba(0, 168, 132, 0.1);
      border-color: var(--accent);
      color: var(--accent);
    }

    .filter-bar {
      background: var(--header-bg);
      padding: 10px 20px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }

    .search-input {
      flex: 1;
      min-width: 200px;
      background: var(--bg-chat);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 13px;
      color: var(--text-primary);
      outline: none;
    }

    .search-input:focus {
      border-color: var(--accent);
    }

    .sender-select {
      background: var(--bg-chat);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 13px;
      color: var(--text-primary);
      outline: none;
      cursor: pointer;
    }

    .chat-body {
      flex: 1;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background-image: radial-gradient(var(--border-color) 0.75px, transparent 0.75px);
      background-size: 20px 20px;
    }

    .msg-row {
      display: flex;
      width: 100%;
    }

    .msg-row.msg-out {
      justify-content: flex-end;
    }

    .msg-row.msg-in {
      justify-content: flex-start;
    }

    .msg-bubble {
      max-width: 75%;
      border-radius: 8px;
      padding: 8px 12px;
      position: relative;
      box-shadow: var(--shadow);
      font-size: 14.2px;
      line-height: 19px;
      word-wrap: break-word;
    }

    .msg-out .msg-bubble {
      background: var(--bubble-out);
      border-top-right-radius: 0;
    }

    .msg-in .msg-bubble {
      background: var(--bubble-in);
      border-top-left-radius: 0;
    }

    .msg-sender {
      font-size: 12.5px;
      font-weight: 600;
      color: #1f7cbb;
      margin-bottom: 4px;
    }

    [data-theme="dark"] .msg-sender {
      color: #53bdeb;
    }

    .msg-quote {
      background: var(--quote-bg);
      border-left: 3.5px solid var(--quote-border);
      padding: 4px 8px;
      border-radius: 4px;
      margin-bottom: 6px;
      font-size: 12.5px;
    }

    .quote-sender {
      font-weight: 600;
      color: var(--accent);
      display: block;
      margin-bottom: 2px;
    }

    .quote-text {
      color: var(--text-secondary);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .msg-media-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(0, 0, 0, 0.06);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12.5px;
      margin-bottom: 4px;
      font-weight: 500;
    }

    [data-theme="dark"] .msg-media-badge {
      background: rgba(255, 255, 255, 0.08);
    }

    .msg-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 4px;
      margin-top: 4px;
      font-size: 11px;
      color: var(--text-secondary);
      float: right;
      margin-left: 14px;
    }

    .msg-status {
      color: #53bdeb;
      font-size: 11px;
      font-weight: bold;
    }

    .msg-reactions {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--header-bg);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 2px 6px;
      font-size: 11px;
      position: absolute;
      bottom: -10px;
      right: 10px;
      box-shadow: var(--shadow);
    }

    @media print {
      body { background: white !important; }
      .app-container {
        box-shadow: none !important;
        margin: 0 !important;
        max-width: 100% !important;
        border-radius: 0 !important;
      }
      .filter-bar, .action-btn { display: none !important; }
      .app-header { position: static !important; }
      .msg-bubble { box-shadow: none !important; border: 1px solid #ddd; }
      .msg-out .msg-bubble { background: #e8f5e9 !important; }
      .msg-in .msg-bubble { background: #f5f5f5 !important; }
    }
  </style>
</head>
<body data-theme="light">
  <div class="app-container">
    <header class="app-header">
      <div class="header-info">
        <div class="chat-avatar">${title.charAt(0).toUpperCase()}</div>
        <div class="header-titles">
          <h1>${title}</h1>
          <p>${total} messages • ${dateRangeStr}</p>
        </div>
      </div>
      <div class="header-actions">
        <button class="action-btn" id="themeToggleBtn" title="Toggle Dark/Light Mode">🌙 Theme</button>
        <button class="action-btn" id="printBtn" title="Print or Save as PDF">🖨️ PDF / Print</button>
      </div>
    </header>

    <div class="filter-bar">
      <input type="text" id="searchInput" class="search-input" placeholder="Search in chat..." />
      <select id="senderFilter" class="sender-select">
        <option value="">All Participants</option>
        ${senderOptions}
      </select>
      <span id="matchCount" style="font-size: 12px; color: var(--text-secondary); margin-left: auto;"></span>
    </div>

    <main class="chat-body" id="chatBody">
      ${messagesHtml}
    </main>
  </div>

  <script>
    (function () {
      const body = document.body;
      const themeBtn = document.getElementById('themeToggleBtn');
      const printBtn = document.getElementById('printBtn');
      const searchInput = document.getElementById('searchInput');
      const senderFilter = document.getElementById('senderFilter');
      const matchCount = document.getElementById('matchCount');
      const rows = document.querySelectorAll('.msg-row');

      // Theme toggle
      themeBtn.addEventListener('click', () => {
        const isDark = body.getAttribute('data-theme') === 'dark';
        body.setAttribute('data-theme', isDark ? 'light' : 'dark');
        themeBtn.textContent = isDark ? '🌙 Theme' : '☀️ Theme';
      });

      // Print PDF
      printBtn.addEventListener('click', () => {
        window.print();
      });

      // Filter function
      function applyFilter() {
        const query = searchInput.value.toLowerCase().trim();
        const selectedSender = senderFilter.value;
        let visibleCount = 0;

        rows.forEach(row => {
          const sender = row.getAttribute('data-sender') || '';
          const text = row.innerText.toLowerCase();
          const matchesQuery = !query || text.includes(query);
          const matchesSender = !selectedSender || sender === selectedSender;

          if (matchesQuery && matchesSender) {
            row.style.display = 'flex';
            visibleCount++;
          } else {
            row.style.display = 'none';
          }
        });

        matchCount.textContent = (query || selectedSender) ? \`Showing \${visibleCount} of \${rows.length}\` : '';
      }

      searchInput.addEventListener('input', applyFilter);
      senderFilter.addEventListener('change', applyFilter);
    })();
  </script>
</body>
</html>`;
  }

  /**
   * Helper: Escape HTML strings
   */
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Browser file downloader
   */
  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 200);
  }

  /**
   * Copy text to system clipboard
   */
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);
        return success;
      }
    } catch (err) {
      console.error('WACopy Pro: Clipboard copy failed', err);
      return false;
    }
  }

  /**
   * Print PDF helper (opens styled HTML in new tab and triggers window.print())
   */
  function printPDF(chatData, options) {
    const htmlContent = toHTML(chatData, options);
    
    // If running in Chrome extension context, ask background worker to open print tab
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ action: 'OPEN_PRINT', html: htmlContent }, (response) => {
        if (chrome.runtime.lastError) {
          // Fallback to window.open
          openPrintWindowFallback(htmlContent);
        }
      });
      return;
    }

    openPrintWindowFallback(htmlContent);
  }

  function openPrintWindowFallback(htmlContent) {
    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const printWindow = window.open(url, '_blank');
    if (printWindow) {
      printWindow.onload = function () {
        setTimeout(() => {
          printWindow.print();
        }, 300);
      };
    }
  }

  return {
    AI_PROMPTS,
    toMarkdown,
    toPlainText,
    toCSV,
    toJSON,
    toHTML,
    downloadFile,
    copyToClipboard,
    printPDF
  };
})();

// Export for ES modules or background workers if needed
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WACopyExporter;
}

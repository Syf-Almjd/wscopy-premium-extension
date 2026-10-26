/**
 * WS Copy & Export (PRO+ for free) - Exporter Module
 * Features:
 * - Markdown, HTML, PDF, TXT, CSV, JSON formatters
 * - In-place Image tracking (embed in chat, preview in HTML, bundle in ZIP)
 * - Voice Note Transcripts with disclaimer: "(AI-generated from voice, may contain errors)"
 * - Pure JavaScript zero-dependency ZIP archive creator (bundles chat + media)
 */

const WACopyExporter = (function () {
  'use strict';

  // AI Prompt templates for 1-click LLM workflows
  const AI_PROMPTS = {
    none: '',
    summary:
      'Please analyze and summarize the following WhatsApp conversation. Highlight the key points, decisions, agreements, and next steps.\n\n---\n\n',
    action_items:
      'Extract all action items, tasks, deadlines, and assignees from this WhatsApp conversation into a prioritized checklist.\n\n---\n\n',
    meeting_notes:
      'Convert this WhatsApp chat transcript into structured meeting minutes with participants, discussion points, and resolutions.\n\n---\n\n',
    qa_insights:
      'Extract the most important questions, answers, and shared recommendations from this WhatsApp conversation.\n\n---\n\n'
  };

  /**
   * Escape CSV field (RFC 4180)
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
   * Pure JS zero-dependency ZIP archiver (STORE mode, 100% compatible)
   */
  function createZip(files) {
    const parts = [];
    const central = [];
    let offset = 0;

    function toBytes(data) {
      if (typeof data === 'string') return new TextEncoder().encode(data);
      if (data instanceof Uint8Array) return data;
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      return new Uint8Array(0);
    }

    function crc32(buf) {
      let crc = -1;
      for (let i = 0; i < buf.length; i++) {
        let b = buf[i];
        for (let j = 0; j < 8; j++) {
          crc = (crc >>> 1) ^ (((crc ^ b) & 1) ? 0xEDB88320 : 0);
          b >>>= 1;
        }
      }
      return (crc ^ -1) >>> 0;
    }

    for (const f of files) {
      const data = toBytes(f.content);
      const nameBytes = new TextEncoder().encode(f.name);
      const crc = crc32(data);
      const size = data.length;

      // Local File Header
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true); // version
      lv.setUint16(6, 0, true);  // flags
      lv.setUint16(8, 0, true);  // compression = STORE
      lv.setUint16(10, 0, true); // mod time
      lv.setUint16(12, 0, true); // mod date
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true); // compressed size
      lv.setUint32(22, size, true); // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      parts.push(local, data);

      // Central Directory Header
      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);

      central.push(cd);
      offset += local.length + data.length;
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) centralSize += c.length;

    // End of Central Directory Record
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralStart, true);
    ev.setUint16(20, 0, true);

    const all = [...parts, ...central, eocd];
    const total = all.reduce((sum, b) => sum + b.length, 0);
    const result = new Uint8Array(total);
    let pos = 0;
    for (const b of all) {
      result.set(b, pos);
      pos += b.length;
    }
    return new Blob([result], { type: 'application/zip' });
  }

  /**
   * Format chat data to Markdown (.md)
   * Tracks images right where they occurred and labels voice note transcripts
   */
  function toMarkdown(chatData, options = {}) {
    const {
      promptType = 'none',
      customPrompt = '',
      includeTimestamps = true,
      includeSenders = true,
      includeMedia = true,
      includeQuotes = true,
      includeReactions = true,
      embedImages = false,
      useRelativePaths = true
    } = options;

    let output = '';

    if (promptType === 'custom' && customPrompt.trim()) {
      output += `${customPrompt.trim()}\n\n---\n\n`;
    } else if (AI_PROMPTS[promptType]) {
      output += AI_PROMPTS[promptType];
    }

    output += `# WhatsApp Chat: ${chatData.chatTitle || 'Conversation'}\n\n`;
    output += `- **Total Messages:** ${chatData.messages.length}\n`;
    if (chatData.dateRange?.start && chatData.dateRange?.end) {
      output += `- **Date Range:** ${chatData.dateRange.start} — ${chatData.dateRange.end}\n`;
    }
    output += `- **Exported At:** ${new Date().toLocaleString()}\n`;
    output += `- **Tool:** WS Copy & Export (PRO+ for free)\n\n`;
    output += `---\n\n`;

    let imageCounter = 0;
    let voiceCounter = 0;

    for (const msg of chatData.messages) {
      let line = '';

      if (includeTimestamps && msg.timestamp) {
        line += `[${msg.timestamp}] `;
      }

      if (includeSenders) {
        const sender = msg.isOutgoing ? 'You' : (msg.sender || 'Unknown');
        line += `**${sender}**: `;
      }

      // Quoted reply context
      if (includeQuotes && msg.quoted) {
        line += `\n> ↩️ **${msg.quoted.sender || 'Reply'}**: ${msg.quoted.text.replace(/\n/g, ' ')}\n> \n`;
        if (includeTimestamps && msg.timestamp) line += `[${msg.timestamp}] `;
        if (includeSenders) line += `**${msg.isOutgoing ? 'You' : (msg.sender || 'Unknown')}**: `;
      }

      // Tracked Images
      if (includeMedia && msg.mediaType === 'Image') {
        imageCounter++;
        const filename = msg.mediaFile || `media/image_${imageCounter}.jpg`;
        const caption = msg.text ? ` - ${msg.text}` : '';
        const imgSrc = embedImages && msg.dataUrl ? msg.dataUrl : (useRelativePaths ? filename : (msg.mediaSrc || filename));
        line += `\n\n🖼️ ![Image #${imageCounter}${caption}](${imgSrc})\n`;
        if (msg.text) {
          line += `*Caption:* ${msg.text}\n`;
        }
      }
      // Tracked Voice Notes with Transcription
      else if (includeMedia && msg.mediaType && msg.mediaType.includes('Voice')) {
        voiceCounter++;
        const dur = msg.mediaInfo || 'Audio';
        line += `🎙️ *[Voice Message (${dur})]*\n`;

        if (msg.transcript) {
          line += `> ⚠️ **Voice Note Transcript (AI-generated from voice, may contain errors):**\n`;
          line += `> "${msg.transcript.replace(/\n/g, '\n> ')}"\n`;
        }
        if (msg.text) {
          line += msg.text;
        }
      }
      // Tracked Documents & Files
      else if (includeMedia && msg.mediaType === 'Document') {
        const docName = msg.mediaInfo || 'document.pdf';
        const docPath = msg.mediaFile || `media/${docName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const sizeStr = msg.fileSize ? ` *(${msg.fileSize})*` : '';
        line += `📄 **[Document: ${docName}](${docPath})**${sizeStr}`;
        if (msg.text) line += `\n*Note:* ${msg.text}`;
      }
      // Other media (Video, Sticker, Location)
      else if (includeMedia && msg.mediaType) {
        const icon = msg.mediaType === 'Video' ? '🎥' : msg.mediaType === 'Sticker' ? '✨' : '📎';
        const info = msg.mediaInfo ? `: ${msg.mediaInfo}` : '';
        line += `${icon} *[${msg.mediaType}${info}]* `;
        if (msg.text) line += msg.text;
      }
      // Standard Text Message
      else {
        line += msg.text || '*(empty message)*';
      }

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

    let imgCount = 0;
    let voiceCount = 0;

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

      if (includeMedia && msg.mediaType === 'Image') {
        imgCount++;
        line += `<Image #${imgCount}${msg.mediaFile ? ': ' + msg.mediaFile : ''}> `;
        if (msg.text) line += `(Caption: ${msg.text})`;
      } else if (includeMedia && msg.mediaType && msg.mediaType.includes('Voice')) {
        voiceCount++;
        line += `<Voice Message #${voiceCount} (${msg.mediaInfo || 'Audio'})> `;
        if (msg.transcript) {
          line += `\n   [Voice Transcript (AI-generated from voice, may contain errors): "${msg.transcript}"]`;
        }
        if (msg.text) line += ` ${msg.text}`;
      } else if (includeMedia && msg.mediaType) {
        line += `<${msg.mediaType}${msg.mediaInfo ? ': ' + msg.mediaInfo : ''}> ${msg.text || ''}`;
      } else {
        line += msg.text || '';
      }

      if (includeReactions && msg.reactions && msg.reactions.length > 0) {
        line += ` {Reactions: ${msg.reactions.join(' ')}}`;
      }

      output += `${line.trim()}\n`;
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
      'media_type',
      'media_file',
      'voice_transcript',
      'voice_transcript_warning',
      'reply_to_sender',
      'reply_to_text',
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
        msg.mediaType || '',
        msg.mediaFile || '',
        msg.transcript || '',
        msg.transcript ? 'AI-generated from voice (may contain errors)' : '',
        msg.quoted?.sender || '',
        msg.quoted?.text || '',
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
        tool: 'WS Copy & Export (PRO+ for free)',
        version: '1.1.0',
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
        mediaFile: m.mediaFile || null,
        transcript: m.transcript || null,
        transcriptDisclaimer: m.transcript ? 'AI-generated from voice, may contain errors' : null,
        reactions: m.reactions || []
      }))
    };

    return JSON.stringify(exportObject, null, 2);
  }

  /**
   * Format chat data into a standalone, interactive, beautiful HTML viewer
   * Displays tracked images inline inside chat bubbles, plus voice transcripts with warning!
   */
  function toHTML(chatData, options = {}) {
    const title = escapeHtml(chatData.chatTitle || 'WhatsApp Chat');
    const total = chatData.messages.length;
    const dateRangeStr =
      chatData.dateRange?.start && chatData.dateRange?.end
        ? `${escapeHtml(chatData.dateRange.start)} — ${escapeHtml(chatData.dateRange.end)}`
        : 'All History';

    const senders = new Set();
    chatData.messages.forEach((m) => {
      senders.add(m.isOutgoing ? 'You' : (m.sender || 'Unknown'));
    });
    const senderOptions = Array.from(senders)
      .map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
      .join('');

    let imgIndex = 0;
    let voiceIndex = 0;

    const messagesHtml = chatData.messages
      .map((m, idx) => {
        const isOut = m.isOutgoing;
        const senderName = isOut ? 'You' : (m.sender || 'Unknown');
        const bubbleClass = isOut ? 'msg-out' : 'msg-in';
        const timestamp = m.timestamp ? escapeHtml(m.timestamp) : '';
        const timeOnly = m.time ? escapeHtml(m.time) : timestamp;

        // Quoted message
        let quotedHtml = '';
        if (m.quoted) {
          quotedHtml = `
            <div class="msg-quote">
              <span class="quote-sender">${escapeHtml(m.quoted.sender || 'Reply')}</span>
              <span class="quote-text">${escapeHtml(m.quoted.text || '')}</span>
            </div>
          `;
        }

        // Tracked Inline Image
        let imageHtml = '';
        if (m.mediaType === 'Image') {
          imgIndex++;
          const imgSrc = m.dataUrl || m.mediaSrc || m.mediaFile || '';
          if (imgSrc) {
            imageHtml = `
              <div class="msg-image-card">
                <img src="${imgSrc}" alt="Shared image #${imgIndex}" class="msg-image-thumb" loading="lazy" onclick="window.open(this.src)" />
                <span class="msg-image-badge">📷 Image #${imgIndex}</span>
              </div>
            `;
          } else {
            imageHtml = `<div class="msg-media-badge"><span class="media-icon">🖼️</span><span>Image #${imgIndex}</span></div>`;
          }
        }

        // Tracked Voice Note with Transcript & Warning
        let voiceHtml = '';
        if (m.mediaType && m.mediaType.includes('Voice')) {
          voiceIndex++;
          const dur = m.mediaInfo || '0:15';
          voiceHtml = `
            <div class="msg-voice-card">
              <div class="vn-header">
                <span class="vn-icon">🎙️</span>
                <span class="vn-title">Voice Note #${voiceIndex}</span>
                <span class="vn-duration">${escapeHtml(dur)}</span>
              </div>
              ${m.transcript
              ? `
                <div class="vn-transcript-box">
                  <div class="vn-warning-tag">⚠️ Voice Note Transcript <span class="vn-disclaimer">(AI-generated from voice, may contain errors)</span>:</div>
                  <div class="vn-text">"${escapeHtml(m.transcript)}"</div>
                </div>
              `
              : ''
            }
            </div>
          `;
        }

        // Document Card
        let docHtml = '';
        if (m.mediaType === 'Document') {
          const docName = m.mediaInfo || 'document.pdf';
          const cleanName = docName.replace(/[^a-zA-Z0-9._-]/g, '_');
          const docPath = m.mediaFile || `media/${cleanName}`;
          const ext = docName.split('.').pop().toLowerCase();
          let docIcon = '📄';
          if (ext === 'pdf') docIcon = '📕';
          else if (['doc', 'docx'].includes(ext)) docIcon = '📘';
          else if (['xls', 'xlsx', 'csv'].includes(ext)) docIcon = '📗';
          else if (['ppt', 'pptx'].includes(ext)) docIcon = '📙';
          else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) docIcon = '📦';
          else if (['mp3', 'wav', 'ogg'].includes(ext)) docIcon = '🎵';

          docHtml = `
            <div class="msg-doc-card">
              <span class="doc-icon">${docIcon}</span>
              <div class="doc-details">
                <a class="doc-name" href="${escapeHtml(docPath)}" download="${escapeHtml(docName)}" target="_blank" title="${escapeHtml(docName)}">
                  ${escapeHtml(docName)}
                </a>
                <span class="doc-meta">${m.fileSize ? escapeHtml(m.fileSize) : ext.toUpperCase() + ' Document'}</span>
              </div>
            </div>
          `;
        }

        // Other Media Badges
        let otherMediaHtml = '';
        if (m.mediaType && m.mediaType !== 'Image' && m.mediaType !== 'Document' && !m.mediaType.includes('Voice')) {
          let icon = '📎';
          if (m.mediaType.includes('Video')) icon = '🎥';
          else if (m.mediaType.includes('Sticker')) icon = '✨';
          else if (m.mediaType.includes('Location')) icon = '📍';

          otherMediaHtml = `
            <div class="msg-media-badge">
              <span class="media-icon">${icon}</span>
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
              ${imageHtml}
              ${voiceHtml}
              ${docHtml}
              ${otherMediaHtml}
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
      --warning-bg: #fff8e1;
      --warning-border: #ffe082;
      --warning-text: #8d6e63;
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
      --warning-bg: rgba(255, 193, 7, 0.12);
      --warning-border: rgba(255, 193, 7, 0.3);
      --warning-text: #ffca28;
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

    .search-input:focus { border-color: var(--accent); }

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
      background: var(--chat-bg);
    }

    .msg-row { display: flex; width: 100%; }
    .msg-row.msg-out { justify-content: flex-end; }
    .msg-row.msg-in { justify-content: flex-start; }

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

    [data-theme="dark"] .msg-sender { color: #53bdeb; }

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

    /* Tracked Image Card */
    .msg-image-card {
      margin-bottom: 6px;
      border-radius: 8px;
      overflow: hidden;
      position: relative;
    }

    .msg-image-thumb {
      max-width: 100%;
      max-height: 380px;
      display: block;
      border-radius: 6px;
      cursor: pointer;
      transition: opacity 0.2s;
    }

    .msg-image-thumb:hover { opacity: 0.95; }

    .msg-image-badge {
      font-size: 10.5px;
      color: var(--text-secondary);
      margin-top: 3px;
      display: inline-block;
    }

    /* Tracked Voice Note Card with Warning Banner */
    .msg-voice-card {
      background: rgba(0, 0, 0, 0.04);
      border-radius: 8px;
      padding: 8px 10px;
      margin-bottom: 6px;
    }

    [data-theme="dark"] .msg-voice-card { background: rgba(255, 255, 255, 0.05); }

    .vn-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 6px;
    }

    .vn-duration {
      font-size: 11px;
      color: var(--text-secondary);
      margin-left: auto;
    }

    .vn-transcript-box {
      background: var(--warning-bg);
      border-left: 3px solid var(--warning-border);
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 12.5px;
      line-height: 1.4;
    }

    .vn-warning-tag {
      font-size: 11px;
      font-weight: 700;
      color: var(--warning-text);
      margin-bottom: 2px;
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }

    .vn-disclaimer {
      font-weight: normal;
      font-size: 10.5px;
      opacity: 0.9;
    }

    .vn-text {
      color: var(--text-primary);
      font-style: italic;
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

    [data-theme="dark"] .msg-media-badge { background: rgba(255, 255, 255, 0.08); }

    .msg-doc-card {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      margin: 6px 0;
      background: rgba(0, 0, 0, 0.04);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      transition: background 0.15s ease;
      max-width: 380px;
    }
    [data-theme="dark"] .msg-doc-card {
      background: rgba(255, 255, 255, 0.05);
    }
    .msg-doc-card:hover {
      background: rgba(0, 0, 0, 0.08);
    }
    [data-theme="dark"] .msg-doc-card:hover {
      background: rgba(255, 255, 255, 0.09);
    }
    .doc-icon {
      font-size: 26px;
      flex-shrink: 0;
    }
    .doc-details {
      display: flex;
      flex-direction: column;
      gap: 2px;
      overflow: hidden;
    }
    .doc-name {
      font-size: 13.5px;
      font-weight: 600;
      color: var(--text-primary);
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .doc-name:hover {
      text-decoration: underline;
      color: var(--accent);
    }
    .doc-meta {
      font-size: 11.5px;
      color: var(--text-secondary);
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

    .msg-status { color: #53bdeb; font-size: 11px; font-weight: bold; }

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
      .app-container { box-shadow: none !important; margin: 0 !important; max-width: 100% !important; border-radius: 0 !important; }
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

      themeBtn.addEventListener('click', () => {
        const isDark = body.getAttribute('data-theme') === 'dark';
        body.setAttribute('data-theme', isDark ? 'light' : 'dark');
        themeBtn.textContent = isDark ? '🌙 Theme' : '☀️ Theme';
      });

      printBtn.addEventListener('click', () => window.print());

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
   * Package chat and all captured media files into a ZIP archive
   */
  async function toZIP(chatData, options = {}) {
    const files = [];

    // 1. Generate Markdown with relative media paths
    const md = toMarkdown(chatData, { ...options, useRelativePaths: true, embedImages: false });
    files.push({ name: 'chat.md', content: md });

    // 2. Generate HTML viewer with embedded images
    const html = toHTML(chatData, options);
    files.push({ name: 'chat.html', content: html });

    // 3. Plain text log
    const txt = toPlainText(chatData, options);
    files.push({ name: 'chat.txt', content: txt });

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

    // 4. Add captured media files (images, audio, documents)
    let imgIdx = 0;
    let voiceIdx = 0;
    let docIdx = 0;

    const usedFileNames = new Set();

    for (const msg of chatData.messages) {
      // Images
      if (msg.mediaType === 'Image') {
        imgIdx++;
        const ext = msg.mimeType?.includes('png') ? 'png' : msg.mimeType?.includes('webp') ? 'webp' : 'jpg';
        const filename = `media/image_${imgIdx}.${ext}`;
        msg.mediaFile = filename;

        let bytes = null;
        if (msg.imageBytes) {
          bytes = msg.imageBytes;
        } else if (msg.blob) {
          bytes = new Uint8Array(await msg.blob.arrayBuffer());
        } else if (msg.dataUrl && msg.dataUrl.includes('base64,')) {
          bytes = dataUrlToBytes(msg.dataUrl);
        }

        if (bytes && bytes.length > 0) {
          files.push({ name: filename, content: bytes });
        }
      }

      // Voice Notes / Audio
      if (msg.mediaType && msg.mediaType.includes('Voice')) {
        voiceIdx++;
        const filename = `media/voice_note_${voiceIdx}.ogg`;
        msg.mediaFile = filename;

        let bytes = null;
        if (msg.audioBytes) {
          bytes = msg.audioBytes;
        } else if (msg.audioBlob) {
          bytes = new Uint8Array(await msg.audioBlob.arrayBuffer());
        }

        if (bytes && bytes.length > 0) {
          files.push({ name: filename, content: bytes });
        }
      }

      // Documents (PDF, Word, Excel, ZIP, etc.)
      if (msg.mediaType === 'Document') {
        docIdx++;
        let rawName = (msg.mediaInfo || '').replace(/[^a-zA-Z0-9._-]/g, '_') || `document_${docIdx}.pdf`;
        if (usedFileNames.has(rawName.toLowerCase())) {
          const parts = rawName.split('.');
          if (parts.length > 1) {
            const ext = parts.pop();
            rawName = `${parts.join('.')}_${docIdx}.${ext}`;
          } else {
            rawName = `${rawName}_${docIdx}`;
          }
        }
        usedFileNames.add(rawName.toLowerCase());

        const filename = `media/${rawName}`;
        msg.mediaFile = filename;

        let bytes = null;
        if (msg.docBytes) {
          bytes = msg.docBytes;
        } else if (msg.docBlob) {
          bytes = new Uint8Array(await msg.docBlob.arrayBuffer());
        }

        if (bytes && bytes.length > 0) {
          files.push({ name: filename, content: bytes });
        } else {
          files.push({
            name: `${filename}.missing.txt`,
            content: `Document: ${msg.mediaInfo || 'Document'}\nSize: ${msg.fileSize || 'Unknown'}\nStatus: Media was not cached in this WhatsApp Web session.\nTip: Click the document in WhatsApp Web to load it, then export again!`
          });
        }
      }
    }

    return createZip(files);
  }

  /**
   * Browser file download helper
   */
  function downloadFile(content, filename, mimeType) {
    let blob = content instanceof Blob ? content : new Blob([content], { type: `${mimeType};charset=utf-8` });
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
   * Copy to clipboard
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
      console.error('WACopy Exporter: Clipboard copy failed', err);
      return false;
    }
  }

  /**
   * PDF printing trigger
   */
  function printPDF(chatData, options) {
    const htmlContent = toHTML(chatData, options);

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ action: 'OPEN_PRINT', html: htmlContent }, () => {
        if (chrome.runtime.lastError) {
          openPrintFallback(htmlContent);
        }
      });
      return;
    }

    openPrintFallback(htmlContent);
  }

  function openPrintFallback(htmlContent) {
    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const printWindow = window.open(url, '_blank');
    if (printWindow) {
      printWindow.onload = () => setTimeout(() => printWindow.print(), 300);
    }
  }

  return {
    AI_PROMPTS,
    toMarkdown,
    toPlainText,
    toCSV,
    toJSON,
    toHTML,
    toZIP,
    downloadFile,
    copyToClipboard,
    printPDF
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = WACopyExporter;
}

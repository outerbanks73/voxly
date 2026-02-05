// Transcript Management Page JavaScript
// SpeakToText Local v1.5.4

const CURRENT_VERSION = '1.5.4';

// State
let currentResult = null;
let currentMetadata = null;
let isEditing = false;

// DOM Elements
const transcriptContainer = document.getElementById('transcriptContainer');
const emptyState = document.getElementById('emptyState');
const metadataPanel = document.getElementById('metadataPanel');
const editNotice = document.getElementById('editNotice');
const statusMessage = document.getElementById('statusMessage');

// Metadata elements
const metaSource = document.getElementById('metaSource');
const metaDuration = document.getElementById('metaDuration');
const metaWords = document.getElementById('metaWords');
const metaSpeakers = document.getElementById('metaSpeakers');
const metaLanguage = document.getElementById('metaLanguage');
const metaModel = document.getElementById('metaModel');

// Buttons
const copyBtn = document.getElementById('copyBtn');
const editBtn = document.getElementById('editBtn');
const exportBtn = document.getElementById('exportBtn');
const exportMenu = document.getElementById('exportMenu');
const clearBtn = document.getElementById('clearBtn');

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  await loadTranscriptData();
  setupButtons();
});

// Load transcript data from storage
async function loadTranscriptData() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['transcriptResult', 'transcriptMetadata'], (result) => {
      if (result.transcriptResult) {
        currentResult = result.transcriptResult;
        currentMetadata = result.transcriptMetadata || {};
        displayTranscript();
        displayMetadata();
      } else {
        showEmptyState();
      }
      resolve();
    });
  });
}

// Display the transcript
function displayTranscript() {
  emptyState.style.display = 'none';
  transcriptContainer.innerHTML = '';

  if (currentResult?.segments && currentResult.segments.length > 0) {
    // Display segments with speaker labels
    currentResult.segments.forEach(seg => {
      const segDiv = document.createElement('div');
      segDiv.className = 'segment';

      const headerDiv = document.createElement('div');
      headerDiv.className = 'segment-header';

      if (seg.speaker) {
        const speakerSpan = document.createElement('span');
        speakerSpan.className = 'speaker-label';
        speakerSpan.textContent = seg.speaker;
        headerDiv.appendChild(speakerSpan);
      }

      const timestampSpan = document.createElement('span');
      timestampSpan.className = 'timestamp';
      timestampSpan.textContent = `[${seg.timestamp}]`;
      headerDiv.appendChild(timestampSpan);

      const textDiv = document.createElement('div');
      textDiv.className = 'segment-text';
      textDiv.textContent = seg.text;

      segDiv.appendChild(headerDiv);
      segDiv.appendChild(textDiv);
      transcriptContainer.appendChild(segDiv);
    });
  } else if (currentResult?.full_text) {
    // Display plain text
    transcriptContainer.textContent = currentResult.full_text;
  }
}

// Display metadata
function displayMetadata() {
  const fullText = currentResult?.full_text || '';
  const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length;

  metaSource.textContent = truncateText(currentMetadata?.source || '-', 20);
  metaSource.title = currentMetadata?.source || '';
  metaDuration.textContent = currentMetadata?.duration || '-';
  metaWords.textContent = wordCount > 0 ? wordCount.toLocaleString() : '-';
  metaSpeakers.textContent = currentResult?.speakers?.length > 0 ? currentResult.speakers.length : '-';
  metaLanguage.textContent = currentMetadata?.language?.toUpperCase() || '-';
  metaModel.textContent = currentMetadata?.model || '-';
}

// Truncate text for display
function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

// Show empty state
function showEmptyState() {
  emptyState.style.display = 'block';
  metadataPanel.style.display = 'none';
}

// Setup button handlers
function setupButtons() {
  // Copy button
  copyBtn.addEventListener('click', async () => {
    const text = getPlainText();
    try {
      await navigator.clipboard.writeText(text);
      showStatus('Copied to clipboard!', 'success');
    } catch (err) {
      showStatus('Failed to copy', 'error');
    }
  });

  // Edit button
  editBtn.addEventListener('click', () => {
    toggleEditMode();
  });

  // Export button
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.classList.toggle('show');
  });

  // Close export menu when clicking outside
  document.addEventListener('click', () => {
    exportMenu.classList.remove('show');
  });

  // Export options
  document.getElementById('exportJson').addEventListener('click', () => {
    downloadFile(generateJSON(), 'transcript.json', 'application/json');
    exportMenu.classList.remove('show');
  });

  document.getElementById('exportMd').addEventListener('click', () => {
    downloadFile(generateMarkdown(), 'transcript.md', 'text/markdown');
    exportMenu.classList.remove('show');
  });

  document.getElementById('exportTxt').addEventListener('click', () => {
    downloadFile(getPlainText(), 'transcript.txt', 'text/plain');
    exportMenu.classList.remove('show');
  });

  document.getElementById('exportSrt').addEventListener('click', () => {
    downloadFile(generateSRT(), 'transcript.srt', 'text/plain');
    exportMenu.classList.remove('show');
  });

  document.getElementById('exportVtt').addEventListener('click', () => {
    downloadFile(generateVTT(), 'transcript.vtt', 'text/vtt');
    exportMenu.classList.remove('show');
  });

  // Clear button
  clearBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear the transcript?')) {
      await chrome.storage.local.remove(['transcriptResult', 'transcriptMetadata']);
      currentResult = null;
      currentMetadata = null;
      showEmptyState();
      transcriptContainer.innerHTML = '';
      emptyState.style.display = 'block';
      showStatus('Transcript cleared', 'success');
    }
  });
}

// Toggle edit mode
function toggleEditMode() {
  isEditing = !isEditing;
  transcriptContainer.contentEditable = isEditing;
  transcriptContainer.classList.toggle('editing', isEditing);
  editNotice.classList.toggle('show', isEditing);
  editBtn.classList.toggle('active', isEditing);
  editBtn.textContent = isEditing ? '💾 Save' : '✏️ Edit';

  if (!isEditing) {
    // Save changes
    saveEditedContent();
    showStatus('Changes saved', 'success');
  }
}

// Save edited content
async function saveEditedContent() {
  if (currentResult?.segments) {
    // Update segments from edited content
    const segments = transcriptContainer.querySelectorAll('.segment');
    segments.forEach((segDiv, index) => {
      if (currentResult.segments[index]) {
        const textDiv = segDiv.querySelector('.segment-text');
        if (textDiv) {
          currentResult.segments[index].text = textDiv.textContent;
        }
      }
    });
    // Update full_text
    currentResult.full_text = currentResult.segments.map(s => s.text).join(' ');
  } else if (currentResult) {
    currentResult.full_text = transcriptContainer.textContent;
  }

  // Save to storage
  await chrome.storage.local.set({ transcriptResult: currentResult });
  displayMetadata(); // Update word count
}

// Get plain text
function getPlainText() {
  if (currentResult?.segments && currentResult.segments.length > 0) {
    return currentResult.segments.map(seg => {
      if (seg.speaker) {
        return `[${seg.timestamp}] ${seg.speaker}: ${seg.text}`;
      }
      return `[${seg.timestamp}] ${seg.text}`;
    }).join('\n\n');
  }
  return currentResult?.full_text || transcriptContainer.textContent;
}

// Download file helper
function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Generate JSON export with metadata
function generateJSON() {
  const now = new Date().toISOString();
  const fullText = currentResult?.full_text || '';
  const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length;

  const output = {
    metadata: {
      source: currentMetadata?.source || 'Unknown',
      duration: currentMetadata?.duration || null,
      word_count: wordCount,
      speakers: currentResult?.speakers || [],
      language: currentMetadata?.language || 'en',
      model: currentMetadata?.model || 'base',
      processed_at: currentMetadata?.processed_at || now,
      exported_at: now,
      tool: 'SpeakToText Local',
      version: CURRENT_VERSION
    },
    transcript: {
      full_text: fullText,
      segments: currentResult?.segments || []
    }
  };

  return JSON.stringify(output, null, 2);
}

// Generate Markdown format with rich metadata
function generateMarkdown() {
  const fullText = currentResult?.full_text || '';
  const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length;
  const now = new Date().toISOString();

  // Build YAML frontmatter with metadata
  let md = `---
title: Transcript
date: ${currentMetadata?.processed_at || now}
type: transcript
source: "${currentMetadata?.source || 'Unknown'}"
${currentMetadata?.duration ? `duration: ${currentMetadata.duration}` : ''}
word_count: ${wordCount}
language: ${currentMetadata?.language || 'en'}
model: ${currentMetadata?.model || 'base'}
${currentResult?.speakers?.length > 0 ? `speakers:\n${currentResult.speakers.map(s => `  - ${s}`).join('\n')}` : ''}
tool: SpeakToText Local v${CURRENT_VERSION}
---

# Transcript

`;

  // Add metadata summary section
  if (currentMetadata?.source && currentMetadata.source !== 'Unknown') {
    md += `> **Source:** ${currentMetadata.source}\n\n`;
  }

  if (currentResult?.speakers && currentResult.speakers.length > 0) {
    md += `**Speakers:** ${currentResult.speakers.join(', ')}\n\n---\n\n`;
    currentResult.segments.forEach(seg => {
      md += `**[${seg.timestamp}] ${seg.speaker}:**\n${seg.text}\n\n`;
    });
  } else if (currentResult?.segments) {
    currentResult.segments.forEach(seg => {
      md += `**[${seg.timestamp}]** ${seg.text}\n\n`;
    });
  } else {
    md += fullText;
  }

  return md;
}

// Generate SRT subtitle format
function generateSRT() {
  if (!currentResult || !currentResult.segments) {
    return `1
00:00:00,000 --> 00:10:00,000
${currentResult?.full_text || ''}
`;
  }

  let srt = '';
  currentResult.segments.forEach((seg, index) => {
    const startTime = parseTimestamp(seg.timestamp);
    const nextSeg = currentResult.segments[index + 1];
    const endTime = nextSeg ? parseTimestamp(nextSeg.timestamp) : addSeconds(startTime, 5);

    srt += `${index + 1}\n`;
    srt += `${formatSRTTime(startTime)} --> ${formatSRTTime(endTime)}\n`;
    if (seg.speaker) {
      srt += `[${seg.speaker}] `;
    }
    srt += `${seg.text}\n\n`;
  });

  return srt;
}

// Generate WebVTT subtitle format
function generateVTT() {
  if (!currentResult || !currentResult.segments) {
    return `WEBVTT

00:00:00.000 --> 00:10:00.000
${currentResult?.full_text || ''}
`;
  }

  let vtt = 'WEBVTT\n\n';
  currentResult.segments.forEach((seg, index) => {
    const startTime = parseTimestamp(seg.timestamp);
    const nextSeg = currentResult.segments[index + 1];
    const endTime = nextSeg ? parseTimestamp(nextSeg.timestamp) : addSeconds(startTime, 5);

    vtt += `${formatVTTTime(startTime)} --> ${formatVTTTime(endTime)}\n`;
    if (seg.speaker) {
      vtt += `<v ${seg.speaker}>`;
    }
    vtt += `${seg.text}\n\n`;
  });

  return vtt;
}

// Parse timestamp like "00:00" or "01:23" to seconds
function parseTimestamp(timestamp) {
  const parts = timestamp.split(':').map(Number);
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

// Add seconds to a time value
function addSeconds(seconds, add) {
  return seconds + add;
}

// Format time for SRT (HH:MM:SS,mmm)
function formatSRTTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

// Format time for VTT (HH:MM:SS.mmm)
function formatVTTTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function pad(num, size = 2) {
  return num.toString().padStart(size, '0');
}

// Show status message
function showStatus(message, type) {
  statusMessage.textContent = message;
  statusMessage.className = `status-message ${type}`;
  setTimeout(() => {
    statusMessage.className = 'status-message';
  }, 3000);
}

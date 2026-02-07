// Transcript Management Page JavaScript
// Voxly v1.6.3

const CURRENT_VERSION = '1.6.3';

// State
let currentResult = null;
let currentMetadata = null;
let isEditing = false;
let isEditingMetadata = false;
let currentFormat = 'paragraph'; // Default to paragraph view

// DOM Elements
const transcriptContainer = document.getElementById('transcriptContainer');
const emptyState = document.getElementById('emptyState');
const metadataHeader = document.getElementById('metadataHeader');
const editNotice = document.getElementById('editNotice');
const statusMessage = document.getElementById('statusMessage');

// Metadata elements
const metaTitle = document.getElementById('metaTitle');
const metaUrl = document.getElementById('metaUrl');
const metaPublisher = document.getElementById('metaPublisher');
const metaParticipants = document.getElementById('metaParticipants');
const metaDate = document.getElementById('metaDate');
const metaDuration = document.getElementById('metaDuration');
const metaWords = document.getElementById('metaWords');
const metaLanguage = document.getElementById('metaLanguage');
const metaModel = document.getElementById('metaModel');
const editMetaBtn = document.getElementById('editMetaBtn');

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
  setupFormatToggle();
});

// Load transcript data from storage
async function loadTranscriptData() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['transcriptResult', 'transcriptMetadata'], (result) => {
      if (result.transcriptResult) {
        currentResult = result.transcriptResult;
        currentMetadata = result.transcriptMetadata || {};
        displayMetadata();
        displayTranscript();
      } else {
        showEmptyState();
      }
      resolve();
    });
  });
}

// Display the transcript based on current format
function displayTranscript() {
  emptyState.style.display = 'none';
  transcriptContainer.innerHTML = '';

  if (!currentResult?.segments || currentResult.segments.length === 0) {
    if (currentResult?.full_text) {
      transcriptContainer.textContent = currentResult.full_text;
    }
    return;
  }

  switch (currentFormat) {
    case 'segmented':
      displaySegmented();
      break;
    case 'paragraph':
      displayParagraph();
      break;
    case 'prose':
      displayProse();
      break;
    default:
      displayParagraph();
  }
}

// Segmented view - each segment on its own line
function displaySegmented() {
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
}

// Paragraph view - group consecutive same-speaker segments
function displayParagraph() {
  const paragraphs = groupSegmentsIntoParagraphs(currentResult.segments);

  paragraphs.forEach(para => {
    const paraDiv = document.createElement('div');
    paraDiv.className = 'paragraph';

    const headerDiv = document.createElement('div');
    headerDiv.className = 'paragraph-header';

    if (para.speaker) {
      const speakerSpan = document.createElement('span');
      speakerSpan.className = 'paragraph-speaker';
      speakerSpan.textContent = para.speaker;
      headerDiv.appendChild(speakerSpan);
    }

    const timeSpan = document.createElement('span');
    timeSpan.className = 'paragraph-time';
    timeSpan.textContent = `[${para.startTime}]`;
    headerDiv.appendChild(timeSpan);

    const textDiv = document.createElement('div');
    textDiv.className = 'paragraph-text';
    textDiv.textContent = para.texts.join(' ');

    paraDiv.appendChild(headerDiv);
    paraDiv.appendChild(textDiv);
    transcriptContainer.appendChild(paraDiv);
  });
}

// Prose view - continuous text with inline speaker markers
function displayProse() {
  const proseDiv = document.createElement('div');
  proseDiv.className = 'prose-content';

  let lastSpeaker = null;

  currentResult.segments.forEach(seg => {
    if (seg.speaker && seg.speaker !== lastSpeaker) {
      if (lastSpeaker !== null) {
        proseDiv.appendChild(document.createElement('br'));
        proseDiv.appendChild(document.createElement('br'));
      }
      const speakerSpan = document.createElement('span');
      speakerSpan.className = 'prose-speaker';
      speakerSpan.textContent = `${seg.speaker}: `;
      proseDiv.appendChild(speakerSpan);
      lastSpeaker = seg.speaker;
    }
    proseDiv.appendChild(document.createTextNode(seg.text + ' '));
  });

  transcriptContainer.appendChild(proseDiv);
}

// Group segments into paragraphs with smart breaking
function groupSegmentsIntoParagraphs(segments) {
  const paragraphs = [];
  let currentPara = { speaker: null, texts: [], startTime: null, segmentCount: 0 };

  const MAX_SEGMENTS_PER_PARAGRAPH = 6; // Break every ~6 segments for readability
  const TIME_GAP_THRESHOLD = 10; // Break on 10+ second gaps (natural pauses)

  segments.forEach((seg, index) => {
    // Detect time gap from previous segment
    let timeGap = 0;
    if (index > 0 && seg.start !== undefined && segments[index - 1].start !== undefined) {
      const prevEnd = segments[index - 1].start + (segments[index - 1].duration || 0);
      timeGap = seg.start - prevEnd;
    }

    // Determine if we should start a new paragraph
    // Break on: speaker change, significant time gap, or too many segments
    const speakerChanged = seg.speaker !== currentPara.speaker && (seg.speaker || currentPara.speaker);
    const significantTimeGap = timeGap >= TIME_GAP_THRESHOLD;
    const tooManySegments = currentPara.segmentCount >= MAX_SEGMENTS_PER_PARAGRAPH;

    if (speakerChanged || significantTimeGap || tooManySegments) {
      if (currentPara.texts.length > 0) {
        paragraphs.push(currentPara);
      }
      currentPara = {
        speaker: seg.speaker,
        texts: [seg.text],
        startTime: seg.timestamp,
        segmentCount: 1
      };
    } else {
      currentPara.texts.push(seg.text);
      currentPara.segmentCount++;
    }
  });

  if (currentPara.texts.length > 0) {
    paragraphs.push(currentPara);
  }

  return paragraphs;
}

// Display enhanced metadata
function displayMetadata() {
  if (!currentResult && !currentMetadata) {
    metadataHeader.style.display = 'none';
    return;
  }

  metadataHeader.style.display = 'block';

  // Title
  const title = currentMetadata?.title || currentMetadata?.source || 'Untitled Recording';
  metaTitle.textContent = truncateText(title, 100);
  metaTitle.title = title;

  // URL (only for URL sources)
  if (currentMetadata?.source_type === 'url' && currentMetadata?.source) {
    metaUrl.href = currentMetadata.source;
    metaUrl.textContent = truncateText(currentMetadata.source, 60);
    metaUrl.style.display = 'inline';
  } else {
    metaUrl.style.display = 'none';
  }

  // Publisher/Channel
  if (currentMetadata?.uploader) {
    metaPublisher.textContent = currentMetadata.uploader;
    metaPublisher.style.display = 'inline';
  } else {
    metaPublisher.textContent = 'Add publisher...';
    metaPublisher.style.display = 'inline';
    metaPublisher.style.opacity = '0.5';
  }

  // Participants (speakers)
  if (currentResult?.speakers && currentResult.speakers.length > 0) {
    metaParticipants.textContent = currentResult.speakers.join(', ');
  } else {
    metaParticipants.textContent = 'Add participants...';
    metaParticipants.style.opacity = '0.5';
  }

  // Recorded date
  if (currentMetadata?.upload_date) {
    // Format YYYYMMDD to readable date
    const d = currentMetadata.upload_date;
    if (d.length === 8) {
      const year = d.substring(0, 4);
      const month = d.substring(4, 6);
      const day = d.substring(6, 8);
      metaDate.textContent = `${month}/${day}/${year}`;
    } else {
      metaDate.textContent = d;
    }
  } else if (currentMetadata?.processed_at) {
    const date = new Date(currentMetadata.processed_at);
    metaDate.textContent = date.toLocaleDateString();
  } else {
    metaDate.textContent = 'Add date...';
    metaDate.style.opacity = '0.5';
  }

  // Duration
  metaDuration.textContent = currentMetadata?.duration || formatDuration(currentMetadata?.duration_seconds) || '-';

  // Word count
  const fullText = currentResult?.full_text || '';
  const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length;
  metaWords.textContent = wordCount > 0 ? wordCount.toLocaleString() : '-';

  // Language
  metaLanguage.textContent = currentMetadata?.language?.toUpperCase() || '-';

  // Model
  metaModel.textContent = currentMetadata?.model || '-';
}

// Format duration seconds to MM:SS or HH:MM:SS
function formatDuration(seconds) {
  if (!seconds) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${pad(m)}:${pad(s)}`;
  }
  return `${m}:${pad(s)}`;
}

// Truncate text for display
function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

// Show empty state
function showEmptyState() {
  emptyState.style.display = 'block';
  metadataHeader.style.display = 'none';
}

// Setup format toggle buttons
function setupFormatToggle() {
  const formatBtns = document.querySelectorAll('.format-btn');
  formatBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      formatBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFormat = btn.dataset.format;
      displayTranscript();
    });
  });
}

// Setup button handlers
function setupButtons() {
  // Copy button
  copyBtn.addEventListener('click', async () => {
    const text = getFormattedText();
    try {
      await navigator.clipboard.writeText(text);
      showStatus('Copied to clipboard!', 'success');
    } catch (err) {
      showStatus('Failed to copy', 'error');
    }
  });

  // Edit button (transcript)
  editBtn.addEventListener('click', () => {
    toggleEditMode();
  });

  // Edit Metadata button
  editMetaBtn.addEventListener('click', () => {
    toggleMetadataEdit();
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
    downloadFile(getFormattedText(), 'transcript.txt', 'text/plain');
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

// Toggle metadata edit mode
function toggleMetadataEdit() {
  isEditingMetadata = !isEditingMetadata;

  const editableFields = [metaTitle, metaPublisher, metaParticipants, metaDate];

  editableFields.forEach(field => {
    field.contentEditable = isEditingMetadata;
    field.classList.toggle('editable', isEditingMetadata);
    if (isEditingMetadata) {
      field.style.opacity = '1';
    }
  });

  editMetaBtn.classList.toggle('active', isEditingMetadata);
  editMetaBtn.textContent = isEditingMetadata ? '💾 Save Metadata' : '✏️ Edit Metadata';

  if (!isEditingMetadata) {
    saveMetadataEdits();
    showStatus('Metadata saved', 'success');
  }
}

// Save edited metadata
async function saveMetadataEdits() {
  // Update metadata object
  currentMetadata.title = metaTitle.textContent;

  const publisherText = metaPublisher.textContent;
  if (publisherText && publisherText !== 'Add publisher...') {
    currentMetadata.uploader = publisherText;
  }

  const participantsText = metaParticipants.textContent;
  if (participantsText && participantsText !== 'Add participants...') {
    // Update speakers array
    currentResult.speakers = participantsText.split(',').map(s => s.trim()).filter(s => s);
  }

  const dateText = metaDate.textContent;
  if (dateText && dateText !== 'Add date...') {
    currentMetadata.recorded_date = dateText;
  }

  // Save to storage
  await chrome.storage.local.set({
    transcriptResult: currentResult,
    transcriptMetadata: currentMetadata
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
    saveEditedContent();
    showStatus('Changes saved', 'success');
  }
}

// Save edited content
async function saveEditedContent() {
  // For segmented/paragraph view, try to extract from DOM
  if (currentFormat === 'segmented' && currentResult?.segments) {
    const segments = transcriptContainer.querySelectorAll('.segment');
    segments.forEach((segDiv, index) => {
      if (currentResult.segments[index]) {
        const textDiv = segDiv.querySelector('.segment-text');
        if (textDiv) {
          currentResult.segments[index].text = textDiv.textContent;
        }
      }
    });
  } else if (currentFormat === 'paragraph' && currentResult?.segments) {
    // For paragraph mode, we need to handle differently
    // Just update full_text from container
    currentResult.full_text = transcriptContainer.textContent;
  } else if (currentResult) {
    currentResult.full_text = transcriptContainer.textContent;
  }

  // Regenerate full_text from segments if we have them
  if (currentResult?.segments) {
    currentResult.full_text = currentResult.segments.map(s => s.text).join(' ');
  }

  // Save to storage
  await chrome.storage.local.set({ transcriptResult: currentResult });
  displayMetadata(); // Update word count
}

// Get formatted text based on current view mode
function getFormattedText() {
  if (!currentResult?.segments || currentResult.segments.length === 0) {
    return currentResult?.full_text || transcriptContainer.textContent;
  }

  switch (currentFormat) {
    case 'segmented':
      return currentResult.segments.map(seg => {
        if (seg.speaker) {
          return `[${seg.timestamp}] ${seg.speaker}: ${seg.text}`;
        }
        return `[${seg.timestamp}] ${seg.text}`;
      }).join('\n\n');

    case 'paragraph':
      const paragraphs = groupSegmentsIntoParagraphs(currentResult.segments);
      return paragraphs.map(para => {
        const header = para.speaker ? `[${para.startTime}] ${para.speaker}:` : `[${para.startTime}]`;
        return `${header}\n${para.texts.join(' ')}`;
      }).join('\n\n');

    case 'prose':
      let prose = '';
      let lastSpeaker = null;
      currentResult.segments.forEach(seg => {
        if (seg.speaker && seg.speaker !== lastSpeaker) {
          if (lastSpeaker !== null) prose += '\n\n';
          prose += `${seg.speaker}: `;
          lastSpeaker = seg.speaker;
        }
        prose += seg.text + ' ';
      });
      return prose.trim();

    default:
      return currentResult.full_text;
  }
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

// Generate JSON export with enhanced metadata
function generateJSON() {
  const now = new Date().toISOString();
  const fullText = currentResult?.full_text || '';
  const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length;

  const output = {
    metadata: {
      title: currentMetadata?.title || 'Untitled',
      source: currentMetadata?.source || 'Unknown',
      source_type: currentMetadata?.source_type || 'unknown',
      uploader: currentMetadata?.uploader || null,
      upload_date: currentMetadata?.upload_date || null,
      duration: currentMetadata?.duration || null,
      duration_seconds: currentMetadata?.duration_seconds || null,
      word_count: wordCount,
      speakers: currentResult?.speakers || [],
      language: currentMetadata?.language || 'en',
      model: currentMetadata?.model || 'base',
      processed_at: currentMetadata?.processed_at || now,
      exported_at: now,
      tool: 'Voxly',
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

  // Build YAML frontmatter with enhanced metadata
  let md = `---
title: "${currentMetadata?.title || 'Transcript'}"
date: ${currentMetadata?.processed_at || now}
type: transcript
source: "${currentMetadata?.source || 'Unknown'}"
${currentMetadata?.uploader ? `uploader: "${currentMetadata.uploader}"` : ''}
${currentMetadata?.upload_date ? `upload_date: ${currentMetadata.upload_date}` : ''}
${currentMetadata?.duration ? `duration: ${currentMetadata.duration}` : ''}
word_count: ${wordCount}
language: ${currentMetadata?.language || 'en'}
model: ${currentMetadata?.model || 'base'}
${currentResult?.speakers?.length > 0 ? `speakers:\n${currentResult.speakers.map(s => `  - "${s}"`).join('\n')}` : ''}
tool: Voxly v${CURRENT_VERSION}
---

# ${currentMetadata?.title || 'Transcript'}

`;

  // Add metadata summary
  if (currentMetadata?.uploader) {
    md += `**Publisher:** ${currentMetadata.uploader}\n\n`;
  }
  if (currentMetadata?.source && currentMetadata.source_type === 'url') {
    md += `**Source:** [${truncateText(currentMetadata.source, 50)}](${currentMetadata.source})\n\n`;
  }
  if (currentResult?.speakers && currentResult.speakers.length > 0) {
    md += `**Participants:** ${currentResult.speakers.join(', ')}\n\n`;
  }
  if (currentMetadata?.duration) {
    md += `**Duration:** ${currentMetadata.duration}\n\n`;
  }

  md += `---\n\n`;

  // Format transcript based on current view mode
  if (currentFormat === 'prose' && currentResult?.segments) {
    let lastSpeaker = null;
    currentResult.segments.forEach(seg => {
      if (seg.speaker && seg.speaker !== lastSpeaker) {
        if (lastSpeaker !== null) md += '\n\n';
        md += `**${seg.speaker}:** `;
        lastSpeaker = seg.speaker;
      }
      md += seg.text + ' ';
    });
  } else if (currentFormat === 'paragraph' && currentResult?.segments) {
    const paragraphs = groupSegmentsIntoParagraphs(currentResult.segments);
    paragraphs.forEach(para => {
      if (para.speaker) {
        md += `**[${para.startTime}] ${para.speaker}:**\n${para.texts.join(' ')}\n\n`;
      } else {
        md += `**[${para.startTime}]** ${para.texts.join(' ')}\n\n`;
      }
    });
  } else if (currentResult?.segments) {
    currentResult.segments.forEach(seg => {
      if (seg.speaker) {
        md += `**[${seg.timestamp}] ${seg.speaker}:**\n${seg.text}\n\n`;
      } else {
        md += `**[${seg.timestamp}]** ${seg.text}\n\n`;
      }
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

// Transcript Management Page JavaScript
// CURRENT_VERSION and other constants are defined in config.js

// Sanitize HTML from AI summaries to prevent XSS
function sanitizeHTML(html) {
  if (typeof DOMPurify !== 'undefined') {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['h3', 'h4', 'ul', 'ol', 'li', 'p', 'a', 'strong', 'em', 'br', 'div', 'span'],
      ALLOWED_ATTR: ['href', 'target', 'class']
    });
  }
  // Fallback: strip all HTML tags
  const div = document.createElement('div');
  div.textContent = html;
  return div.innerHTML;
}

// ExtensionPay for premium subscriptions
const extpay = ExtPay('voxly'); // TODO: Replace with your ExtensionPay extension ID

// Helper: Check if speaker is valid (not null, undefined, or the string "null")
function isValidSpeaker(speaker) {
  return speaker && speaker !== 'null' && speaker !== 'undefined';
}

// Helper: Create YouTube timestamp URL from seconds
function createYouTubeTimestampUrl(seconds) {
  if (!currentMetadata?.source) return null;
  if (seconds == null || isNaN(seconds)) return null;
  const url = currentMetadata.source;

  // Extract video ID from various YouTube URL formats
  const match = url.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/);
  if (match) {
    return `https://www.youtube.com/watch?v=${match[1]}&t=${Math.floor(seconds)}s`;
  }
  return null;
}

// State
let currentResult = null;
let currentMetadata = null;
let isEditing = false;
let isEditingMetadata = false;
let currentFormat = 'paragraph'; // Default to paragraph view
let cloudTranscriptId = null; // Set when viewing a cloud transcript

// Toggle collapsible section
function toggleSection(sectionId) {
  const section = document.getElementById(sectionId + 'Section');
  if (section) {
    section.classList.toggle('expanded');
  }
}

// updateSummaryPreview removed — summary now displays in the transcript container

function updateTranscriptPreview() {
  const transcriptPreview = document.getElementById('transcriptPreview');
  if (transcriptPreview && currentResult?.full_text) {
    const text = currentResult.full_text;
    const preview = text.substring(0, SUMMARY_PREVIEW_LENGTH).trim();
    transcriptPreview.textContent = preview + (text.length > SUMMARY_PREVIEW_LENGTH ? '...' : '');
  } else if (transcriptPreview) {
    transcriptPreview.textContent = 'Click to expand and view transcript...';
  }
}

// Setup section header click handlers (avoiding inline onclick for CSP compliance)
function setupSectionHeaders() {
  const transcriptHeader = document.getElementById('transcriptHeader');
  if (transcriptHeader) {
    transcriptHeader.addEventListener('click', () => toggleSection('transcript'));
  }
}

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
  setupSectionHeaders();
  await loadTranscriptData();
  setupButtons();
  setupFormatToggle();
  setupCloudSaveButton();
  setupShareButton();
});

// Load transcript data from storage or cloud
async function loadTranscriptData() {
  // Check for cloud transcript ID in URL
  const params = new URLSearchParams(window.location.search);
  const cloudId = params.get('id');

  if (cloudId) {
    try {
      const data = await fetchCloudTranscript(cloudId);
      if (data) {
        cloudTranscriptId = data.id;
        currentResult = {
          full_text: data.full_text,
          segments: data.segments || [],
          speakers: data.speakers || [],
          diarization_status: data.diarization_status
        };
        currentMetadata = {
          title: data.title,
          source: data.source,
          source_type: data.source_type,
          uploader: data.uploader,
          duration_seconds: data.duration_seconds,
          duration: data.duration_display,
          language: data.language,
          model: data.model,
          summary: data.summary,
          processed_at: data.processed_at
        };

        displayMetadata();
        displayTranscript();
        updateTranscriptLabel();
        updateTranscriptPreview();

        const transcriptSection = document.getElementById('transcriptSection');
        if (transcriptSection) transcriptSection.classList.add('expanded');
        return;
      }
    } catch (e) {
      console.error('[Voxly] Failed to load cloud transcript:', e);
    }
  }

  return new Promise((resolve) => {
    chrome.storage.local.get(['transcriptResult', 'transcriptMetadata'], (result) => {
      if (result.transcriptResult) {
        currentResult = result.transcriptResult;
        currentMetadata = result.transcriptMetadata || {};

        // Debug logging for diarization troubleshooting
        console.log('[Voxly] Diarization status:', currentResult?.diarization_status);
        console.log('[Voxly] Diarization error:', currentResult?.diarization_error);
        console.log('[Voxly] Speakers found:', currentResult?.speakers);

        displayMetadata();
        displayTranscript();
        updateTranscriptLabel();
        updateTranscriptPreview();

        // Ensure transcript section is expanded so content is visible
        const transcriptSection = document.getElementById('transcriptSection');
        if (transcriptSection) {
          transcriptSection.classList.add('expanded');
        }

        // Summary is now accessed via the "AI Summary" format toggle option
      } else {
        showEmptyState();
      }
      resolve();
    });
  });
}

// autoGenerateSummary removed — AI Summary now generated on-demand via format toggle

// Display the transcript based on current format
function displayTranscript() {
  emptyState.style.display = 'none';
  transcriptContainer.innerHTML = '';

  // AI Summary format uses the same container
  if (currentFormat === 'summary') {
    displayAISummary();
    return;
  }

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

// Display AI summary in the transcript container
async function displayAISummary() {
  if (currentMetadata?.summary) {
    transcriptContainer.innerHTML = sanitizeHTML(currentMetadata.summary);
    return;
  }

  // No summary yet — try to generate one
  const apiKey = await getOpenAIApiKey();
  if (!apiKey) {
    transcriptContainer.innerHTML = '<p style="color:#6b6b6b;">Add your OpenAI API key in <a href="options.html" target="_blank" style="color:#0080FF;">Settings</a> to generate AI summaries.</p>';
    return;
  }

  if (!currentResult?.full_text) {
    transcriptContainer.innerHTML = '<p style="color:#6b6b6b;">No transcript available to summarize.</p>';
    return;
  }

  // Generate summary
  transcriptContainer.innerHTML = '<div class="summary-loading"><div class="spinner"></div>Generating AI Summary...</div>';

  try {
    const summary = await generateSummary(apiKey, currentResult.full_text);
    transcriptContainer.innerHTML = sanitizeHTML(summary);
    currentMetadata.summary = summary;
    await chrome.storage.local.set({ transcriptMetadata: currentMetadata });
    showStatus('AI Summary generated!', 'success');
  } catch (e) {
    transcriptContainer.innerHTML = '<p style="color:#dc3545;">Failed to generate summary. Check your OpenAI API key and try again.</p>';
    showStatus(`Error: ${e.message}`, 'error');
  }
}

// Segmented view - each segment on its own line
function displaySegmented() {
  currentResult.segments.forEach(seg => {
    const segDiv = document.createElement('div');
    segDiv.className = 'segment';

    const headerDiv = document.createElement('div');
    headerDiv.className = 'segment-header';

    if (isValidSpeaker(seg.speaker)) {
      const speakerSpan = document.createElement('span');
      speakerSpan.className = 'speaker-label';
      speakerSpan.textContent = seg.speaker;
      headerDiv.appendChild(speakerSpan);
    }

    // Create timestamp as hyperlink if YouTube URL available
    const timestampUrl = createYouTubeTimestampUrl(seg.start);
    if (timestampUrl) {
      const timestampLink = document.createElement('a');
      timestampLink.href = timestampUrl;
      timestampLink.target = '_blank';
      timestampLink.className = 'timestamp-link';
      timestampLink.textContent = `[${seg.timestamp}]`;
      headerDiv.appendChild(timestampLink);
    } else {
      const timestampSpan = document.createElement('span');
      timestampSpan.className = 'timestamp';
      timestampSpan.textContent = `[${seg.timestamp}]`;
      headerDiv.appendChild(timestampSpan);
    }

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

    if (isValidSpeaker(para.speaker)) {
      const speakerSpan = document.createElement('span');
      speakerSpan.className = 'paragraph-speaker';
      speakerSpan.textContent = para.speaker;
      headerDiv.appendChild(speakerSpan);
    }

    // Create timestamp as hyperlink if YouTube URL available
    const timestampUrl = createYouTubeTimestampUrl(para.startSeconds);
    if (timestampUrl) {
      const timeLink = document.createElement('a');
      timeLink.href = timestampUrl;
      timeLink.target = '_blank';
      timeLink.className = 'timestamp-link';
      timeLink.textContent = `[${para.startTime}]`;
      headerDiv.appendChild(timeLink);
    } else {
      const timeSpan = document.createElement('span');
      timeSpan.className = 'paragraph-time';
      timeSpan.textContent = `[${para.startTime}]`;
      headerDiv.appendChild(timeSpan);
    }

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
    if (isValidSpeaker(seg.speaker) && seg.speaker !== lastSpeaker) {
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
  let currentPara = { speaker: null, texts: [], startTime: null, startSeconds: 0, segmentCount: 0 };

  // Config constants from config.js
  const maxSegments = MAX_SEGMENTS_PER_PARAGRAPH;
  const timeGapThreshold = TIME_GAP_THRESHOLD_S;

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
    const significantTimeGap = timeGap >= timeGapThreshold;
    const tooManySegments = currentPara.segmentCount >= maxSegments;

    if (speakerChanged || significantTimeGap || tooManySegments) {
      if (currentPara.texts.length > 0) {
        paragraphs.push(currentPara);
      }
      currentPara = {
        speaker: seg.speaker,
        texts: [seg.text],
        startTime: seg.timestamp,
        startSeconds: seg.start || 0,
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

  // Participants (speakers) - only show if speakers detected, hide otherwise
  const participantsRow = document.getElementById('participantsRow');
  if (currentResult?.speakers && currentResult.speakers.length > 0) {
    metaParticipants.textContent = currentResult.speakers.join(', ');
    metaParticipants.style.color = '';
    metaParticipants.style.opacity = '';
    if (participantsRow) participantsRow.style.display = '';
  } else {
    // Hide the participants row if no speakers detected (failed, skipped, or none)
    if (participantsRow) participantsRow.style.display = 'none';
    // Log for debugging
    if (currentResult?.diarization_status === 'failed') {
      console.log('[Voxly] Diarization failed:', currentResult.diarization_error);
    }
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
      updateTranscriptLabel();
      displayTranscript();
    });
  });
  // Set initial label
  updateTranscriptLabel();
}

// Update transcript section label based on current view mode
function updateTranscriptLabel() {
  const labels = {
    'segmented': '📄 Segmented Timestamps',
    'paragraph': '📄 Full Transcript',
    'prose': '📄 No Timestamps',
    'summary': '✨ AI Summary'
  };
  const transcriptLabel = document.getElementById('transcriptLabel');
  if (transcriptLabel) {
    transcriptLabel.textContent = labels[currentFormat] || '📄 Transcript';
  }
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

  document.getElementById('exportPdf').addEventListener('click', () => {
    exportMenu.classList.remove('show');
    window.print();
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

  // Upgrade modal buttons
  setupUpgradeModal();
}

// Setup upgrade modal
function setupUpgradeModal() {
  const modal = document.getElementById('upgradeModal');
  const closeBtn = document.getElementById('closeUpgradeModal');
  const subscribeBtn = document.getElementById('subscribeBtn');

  if (closeBtn) {
    closeBtn.onclick = () => {
      modal.style.display = 'none';
    };
  }

  if (subscribeBtn) {
    subscribeBtn.onclick = () => {
      extpay.openPaymentPage();
      modal.style.display = 'none';
    };
  }

  if (modal) {
    modal.onclick = (e) => {
      if (e.target === modal) {
        modal.style.display = 'none';
      }
    };
  }
}

// Show upgrade modal
function showUpgradeModal() {
  const modal = document.getElementById('upgradeModal');
  if (modal) {
    modal.style.display = 'flex';
  }
}

// Check if user is premium
async function isPremiumUser() {
  try {
    const user = await extpay.getUser();
    return user.paid === true;
  } catch (e) {
    console.log('ExtPay check failed:', e);
    return false;
  }
}

// Get OpenAI API key from storage
async function getOpenAIApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['openaiApiKey'], (result) => {
      resolve(result.openaiApiKey || '');
    });
  });
}

// handleSummarize removed — AI Summary is now a format option in the format toggle

// Call OpenAI API to generate summary
async function generateSummary(apiKey, text) {
  // Truncate text if too long (GPT-4o-mini has 128k context, but we'll be conservative)
  const maxChars = 100000;
  const truncatedText = text.length > maxChars ? text.substring(0, maxChars) + '...' : text;

  // Build YouTube URL for timestamp hyperlinks
  const youtubeUrl = currentMetadata?.source || '';
  const isYouTube = youtubeUrl.includes('youtube.com') || youtubeUrl.includes('youtu.be');

  // Extract video ID for timestamp URLs
  let videoId = '';
  const videoIdMatch = youtubeUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/);
  if (videoIdMatch) {
    videoId = videoIdMatch[1];
  }

  const systemPrompt = isYouTube
    ? `As an expert conversationalist, summarize the transcript and format your output into clean paragraphs with titles and bulleted items. As you do this - strategically preserve timestamps and publish timestamps as HTML hyperlinks to the youtube video at that exact timestamp.

When including timestamps, format them as HTML links like this:
<a href="https://youtube.com/watch?v=${videoId}&t=45s" target="_blank">[00:45]</a>

Use HTML formatting for structure:
- Use <h3> for section titles
- Use <ul> and <li> for bullet points
- Use <p> for paragraphs
- Use <strong> for emphasis`
    : `As an expert conversationalist, summarize the transcript and format your output into clean paragraphs with titles and bulleted items. Provide key takeaways with timestamps when relevant.

Use HTML formatting for structure:
- Use <h3> for section titles
- Use <ul> and <li> for bullet points
- Use <p> for paragraphs
- Use <strong> for emphasis`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: `Please summarize the following transcript:\n\n${truncatedText}`
        }
      ],
      max_tokens: OPENAI_MAX_TOKENS,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'API request failed');
  }

  const data = await response.json();
  return data.choices[0].message.content;
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
  editMetaBtn.textContent = isEditingMetadata ? '💾 Save' : '✏️ Edit';

  if (!isEditingMetadata) {
    saveMetadataEdits();
    showStatus('Metadata saved', 'success');
  }
}

// toggleSummaryEdit removed — summary editing uses the same edit button as transcripts

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
  // AI Summary format — save to metadata, not transcript
  if (currentFormat === 'summary') {
    currentMetadata.summary = transcriptContainer.innerHTML;
    await chrome.storage.local.set({ transcriptMetadata: currentMetadata });
    return;
  }

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
  // AI Summary — copy the summary text
  if (currentFormat === 'summary') {
    return currentMetadata?.summary ? transcriptContainer.textContent : '';
  }

  if (!currentResult?.segments || currentResult.segments.length === 0) {
    return currentResult?.full_text || transcriptContainer.textContent;
  }

  switch (currentFormat) {
    case 'segmented':
      return currentResult.segments.map(seg => {
        if (isValidSpeaker(seg.speaker)) {
          return `[${seg.timestamp}] ${seg.speaker}: ${seg.text}`;
        }
        return `[${seg.timestamp}] ${seg.text}`;
      }).join('\n\n');

    case 'paragraph':
      const paragraphs = groupSegmentsIntoParagraphs(currentResult.segments);
      return paragraphs.map(para => {
        const header = isValidSpeaker(para.speaker) ? `[${para.startTime}] ${para.speaker}:` : `[${para.startTime}]`;
        return `${header}\n${para.texts.join(' ')}`;
      }).join('\n\n');

    case 'prose':
      let prose = '';
      let lastSpeaker = null;
      currentResult.segments.forEach(seg => {
        if (isValidSpeaker(seg.speaker) && seg.speaker !== lastSpeaker) {
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
      if (isValidSpeaker(seg.speaker) && seg.speaker !== lastSpeaker) {
        if (lastSpeaker !== null) md += '\n\n';
        md += `**${seg.speaker}:** `;
        lastSpeaker = seg.speaker;
      }
      md += seg.text + ' ';
    });
  } else if (currentFormat === 'paragraph' && currentResult?.segments) {
    const paragraphs = groupSegmentsIntoParagraphs(currentResult.segments);
    paragraphs.forEach(para => {
      if (isValidSpeaker(para.speaker)) {
        md += `**[${para.startTime}] ${para.speaker}:**\n${para.texts.join(' ')}\n\n`;
      } else {
        md += `**[${para.startTime}]** ${para.texts.join(' ')}\n\n`;
      }
    });
  } else if (currentResult?.segments) {
    currentResult.segments.forEach(seg => {
      if (isValidSpeaker(seg.speaker)) {
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
    if (isValidSpeaker(seg.speaker)) {
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
    if (isValidSpeaker(seg.speaker)) {
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
  }, STATUS_MESSAGE_TIMEOUT_MS);
}

// Setup cloud save button (shown when user is authenticated and viewing a local transcript)
async function setupCloudSaveButton() {
  const saveBtn = document.getElementById('saveCloudBtn');
  if (!saveBtn) return;

  // Hide if already a cloud transcript
  if (cloudTranscriptId) {
    saveBtn.style.display = 'none';
    return;
  }

  // Show only for authenticated premium users with a local transcript
  try {
    const canUse = await canUseCloudFeatures();
    if (canUse && currentResult) {
      saveBtn.style.display = 'inline-flex';
    } else {
      saveBtn.style.display = 'none';
    }
  } catch (e) {
    saveBtn.style.display = 'none';
  }

  saveBtn.addEventListener('click', async () => {
    if (!currentResult) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const id = await syncTranscriptToCloud(currentResult, currentMetadata || {});
      if (id) {
        cloudTranscriptId = id;
        showStatus('Saved to cloud!', 'success');
        saveBtn.textContent = '☁️ Saved';
        saveBtn.disabled = true;
      }
    } catch (e) {
      showStatus(`Cloud save failed: ${e.message}`, 'error');
      saveBtn.textContent = '☁️ Save to Cloud';
      saveBtn.disabled = false;
    }
  });
}

// ============================================================
// Sharing
// ============================================================

// Setup share button (only for cloud transcripts)
let _shareListenersAttached = false;
function setupShareButton() {
  const shareBtn = document.getElementById('shareBtn');
  if (!shareBtn) return;

  // Only show share button for cloud transcripts
  if (!cloudTranscriptId) {
    shareBtn.style.display = 'none';
    return;
  }

  shareBtn.style.display = 'inline-flex';

  if (_shareListenersAttached) return;
  _shareListenersAttached = true;

  shareBtn.addEventListener('click', () => {
    openShareModal();
  });

  // Close modal
  const closeBtn = document.getElementById('closeShareModal');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeShareModal);
  }

  const modal = document.getElementById('shareModal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeShareModal();
    });
  }

  // Public toggle
  const publicToggle = document.getElementById('publicToggle');
  if (publicToggle) publicToggle.addEventListener('change', handlePublicToggle);

  // Share invite
  const shareInviteBtn = document.getElementById('shareInviteBtn');
  if (shareInviteBtn) shareInviteBtn.addEventListener('click', handleShareInvite);

  // Copy link
  const copyLinkBtn = document.getElementById('copyLinkBtn');
  if (copyLinkBtn) {
    copyLinkBtn.addEventListener('click', async () => {
      const input = document.getElementById('publicLinkInput');
      if (!input) return;
      try {
        await navigator.clipboard.writeText(input.value);
        showStatus('Link copied!', 'success');
      } catch (e) {
        showStatus('Failed to copy link', 'error');
      }
    });
  }
}

async function openShareModal() {
  const modal = document.getElementById('shareModal');
  if (!modal) return;
  modal.style.display = 'flex';

  // Load current share state
  try {
    const transcript = await fetchCloudTranscript(cloudTranscriptId);
    const toggle = document.getElementById('publicToggle');
    const linkContainer = document.getElementById('publicLinkContainer');
    const linkInput = document.getElementById('publicLinkInput');

    toggle.checked = transcript.is_public;
    if (transcript.is_public && transcript.share_token) {
      linkContainer.style.display = 'flex';
      linkInput.value = `${SUPABASE_URL.replace('.supabase.co', '')}.share.voxly.app/t/${transcript.share_token}`;
    } else {
      linkContainer.style.display = 'none';
    }

    // Load active shares
    await loadActiveShares();
  } catch (e) {
    console.error('[Voxly] Failed to load share state:', e);
  }
}

function closeShareModal() {
  const modal = document.getElementById('shareModal');
  if (modal) modal.style.display = 'none';
}

async function handlePublicToggle(e) {
  const makePublic = e.target.checked;
  const linkContainer = document.getElementById('publicLinkContainer');
  const linkInput = document.getElementById('publicLinkInput');

  try {
    const token = await togglePublicShare(cloudTranscriptId, makePublic);
    if (makePublic && token) {
      linkContainer.style.display = 'flex';
      linkInput.value = `${SUPABASE_URL.replace('.supabase.co', '')}.share.voxly.app/t/${token}`;
      showStatus('Public link enabled!', 'success');
    } else {
      linkContainer.style.display = 'none';
      showStatus('Public link disabled', 'success');
    }
  } catch (e) {
    e.target.checked = !makePublic; // Revert toggle
    showStatus(`Failed: ${e.message}`, 'error');
  }
}

async function handleShareInvite() {
  const emailInput = document.getElementById('shareEmailInput');
  const permSelect = document.getElementById('sharePermission');
  const statusEl = document.getElementById('shareInviteStatus');
  if (!emailInput || !permSelect || !statusEl) return;
  const email = emailInput.value.trim();

  if (!email) {
    statusEl.className = 'share-status error';
    statusEl.textContent = 'Enter an email address.';
    return;
  }

  try {
    await shareTranscriptWithUser(cloudTranscriptId, email, permSelect.value);
    statusEl.className = 'share-status success';
    statusEl.textContent = `Shared with ${email}!`;
    emailInput.value = '';
    await loadActiveShares();
  } catch (e) {
    statusEl.className = 'share-status error';
    statusEl.textContent = e.message;
  }

  setTimeout(() => { statusEl.textContent = ''; }, 5000);
}

async function loadActiveShares() {
  const section = document.getElementById('activeSharesSection');
  const list = document.getElementById('activeSharesList');

  try {
    const shares = await getTranscriptShares(cloudTranscriptId);
    if (shares.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    list.innerHTML = '';

    shares.forEach(share => {
      const item = document.createElement('div');
      item.className = 'share-item';

      const displayName = share.profile?.display_name || share.profile?.email || 'Unknown';
      const email = share.profile?.email || '';

      item.innerHTML = `
        <div class="share-item-info">
          <span class="share-item-email">${escapeHtmlForShare(displayName)}</span>
          <span class="share-item-perm">${escapeHtmlForShare(email)} &middot; ${share.permission === 'write' ? 'Can edit' : 'View only'}</span>
        </div>
        <button class="share-revoke-btn" data-share-id="${share.id}">Revoke</button>
      `;

      item.querySelector('.share-revoke-btn').addEventListener('click', async () => {
        try {
          await revokeTranscriptShare(share.id);
          showStatus('Share revoked', 'success');
          await loadActiveShares();
        } catch (e) {
          showStatus(`Failed: ${e.message}`, 'error');
        }
      });

      list.appendChild(item);
    });
  } catch (e) {
    console.error('[Voxly] Failed to load shares:', e);
  }
}

function escapeHtmlForShare(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

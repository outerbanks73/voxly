// Voxly - Public Share Viewer
// Loads and displays a publicly shared transcript by share token.
// No authentication required — uses Supabase anon key with RLS.

document.addEventListener('DOMContentLoaded', async () => {
  const token = getShareToken();
  if (!token) {
    showError('Invalid share link', 'No share token found in the URL.');
    return;
  }

  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('transcripts')
      .select('*')
      .eq('share_token', token)
      .eq('is_public', true)
      .single();

    if (error || !data) {
      showError('Transcript not found', 'This transcript may have been removed or the link is no longer valid.');
      return;
    }

    displayTranscript(data);
  } catch (e) {
    showError('Failed to load', e.message);
  }
});

function getShareToken() {
  // Support both ?token=xxx and /t/xxx URL patterns
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (token) return token;

  // Check path-based pattern: /t/{token}
  const pathMatch = window.location.pathname.match(/\/t\/([a-zA-Z0-9]+)/);
  if (pathMatch) return pathMatch[1];

  return null;
}

function displayTranscript(data) {
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('transcriptContent').style.display = 'block';

  // Title
  document.getElementById('shareTitle').textContent = data.title || 'Untitled';

  // Metadata
  if (data.duration_display) {
    document.getElementById('shareDuration').textContent = `Duration: ${data.duration_display}`;
  }
  if (data.word_count) {
    document.getElementById('shareWords').textContent = `${data.word_count.toLocaleString()} words`;
  }
  if (data.language) {
    document.getElementById('shareLanguage').textContent = `Language: ${data.language.toUpperCase()}`;
  }
  if (data.created_at) {
    document.getElementById('shareDate').textContent = new Date(data.created_at).toLocaleDateString();
  }

  // Transcript content
  const box = document.getElementById('transcriptBox');
  const segments = data.segments || [];

  if (segments.length > 0) {
    renderParagraphs(box, segments);
  } else if (data.full_text) {
    box.textContent = data.full_text;
  } else {
    box.textContent = 'No transcript content.';
  }
}

function renderParagraphs(container, segments) {
  // Group consecutive same-speaker segments into paragraphs
  const paragraphs = [];
  let current = { speaker: null, texts: [], startTime: null };

  segments.forEach((seg, i) => {
    const speakerChanged = seg.speaker !== current.speaker && (seg.speaker || current.speaker);
    const tooMany = current.texts.length >= 8;

    if (speakerChanged || tooMany) {
      if (current.texts.length > 0) paragraphs.push(current);
      current = {
        speaker: seg.speaker,
        texts: [seg.text],
        startTime: seg.timestamp
      };
    } else {
      current.texts.push(seg.text);
    }
  });
  if (current.texts.length > 0) paragraphs.push(current);

  paragraphs.forEach(para => {
    const div = document.createElement('div');
    div.className = 'paragraph';

    const header = document.createElement('div');
    header.className = 'paragraph-header';

    if (para.speaker && para.speaker !== 'null') {
      const speakerSpan = document.createElement('span');
      speakerSpan.className = 'paragraph-speaker';
      speakerSpan.textContent = para.speaker;
      header.appendChild(speakerSpan);
    }

    if (para.startTime) {
      const timeSpan = document.createElement('span');
      timeSpan.className = 'paragraph-time';
      timeSpan.textContent = `[${para.startTime}]`;
      header.appendChild(timeSpan);
    }

    const textDiv = document.createElement('div');
    textDiv.textContent = para.texts.join(' ');

    div.appendChild(header);
    div.appendChild(textDiv);
    container.appendChild(div);
  });
}

function showError(title, text) {
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('errorState').style.display = 'block';
  document.getElementById('errorTitle').textContent = title;
  document.getElementById('errorText').textContent = text;
}

// Voxly - Transcript Library
// Displays cloud-synced transcripts with search, pagination, and shared tab.
// Requires: supabase.js, cloud-auth.js, cloud-sync.js, config.js

const extpay = ExtPay('voxly');

// State
let currentTab = 'my';
let currentPage = 1;
let currentSearch = '';
const PAGE_SIZE = 20;

document.addEventListener('DOMContentLoaded', async () => {
  const canUse = await canUseCloudFeatures();
  if (!canUse) {
    document.getElementById('authRequired').style.display = 'block';
    document.getElementById('libraryContent').style.display = 'none';
    return;
  }

  document.getElementById('authRequired').style.display = 'none';
  document.getElementById('libraryContent').style.display = 'block';

  setupTabs();
  setupSearch();
  setupPagination();
  await loadTranscripts();
});

// Tab switching
function setupTabs() {
  document.querySelectorAll('.library-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      document.querySelectorAll('.library-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = tab.dataset.tab;
      currentPage = 1;
      currentSearch = '';
      document.getElementById('searchInput').value = '';

      // Hide search for shared tab (no full-text search on shared transcripts)
      document.getElementById('searchBar').style.display = currentTab === 'shared' ? 'none' : 'flex';

      await loadTranscripts();
    });
  });
}

// Search
function setupSearch() {
  const searchBtn = document.getElementById('searchBtn');
  const searchInput = document.getElementById('searchInput');

  searchBtn.addEventListener('click', async () => {
    currentSearch = searchInput.value.trim();
    currentPage = 1;
    await loadTranscripts();
  });

  searchInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      currentSearch = searchInput.value.trim();
      currentPage = 1;
      await loadTranscripts();
    }
  });
}

// Pagination
function setupPagination() {
  document.getElementById('prevBtn').addEventListener('click', async () => {
    if (currentPage > 1) {
      currentPage--;
      await loadTranscripts();
    }
  });

  document.getElementById('nextBtn').addEventListener('click', async () => {
    currentPage++;
    await loadTranscripts();
  });
}

// Load transcripts
async function loadTranscripts() {
  const listEl = document.getElementById('transcriptList');
  const emptyEl = document.getElementById('emptyState');
  const loadingEl = document.getElementById('loadingState');
  const paginationEl = document.getElementById('pagination');
  const errorEl = document.getElementById('errorMessage');

  listEl.innerHTML = '';
  emptyEl.style.display = 'none';
  errorEl.style.display = 'none';
  loadingEl.style.display = 'block';
  paginationEl.style.display = 'none';

  try {
    let data, count;

    if (currentTab === 'my') {
      const result = await fetchCloudTranscripts(currentPage, PAGE_SIZE, currentSearch);
      data = result.data;
      count = result.count;
    } else {
      const result = await fetchSharedTranscripts(currentPage, PAGE_SIZE);
      data = result.data;
      count = result.count;
    }

    loadingEl.style.display = 'none';

    if (!data || data.length === 0) {
      emptyEl.style.display = 'block';
      if (currentTab === 'shared') {
        document.getElementById('emptyTitle').textContent = 'No shared transcripts';
        document.getElementById('emptyText').textContent = 'Transcripts shared with you by other users will appear here.';
      } else if (currentSearch) {
        document.getElementById('emptyTitle').textContent = 'No results';
        document.getElementById('emptyText').textContent = `No transcripts match "${currentSearch}". Try a different search term.`;
      } else {
        document.getElementById('emptyTitle').textContent = 'No transcripts yet';
        document.getElementById('emptyText').textContent = 'Transcribe audio or video from the Voxly side panel and your transcripts will appear here automatically.';
      }
      return;
    }

    if (currentTab === 'my') {
      renderMyTranscripts(data);
    } else {
      renderSharedTranscripts(data);
    }

    // Pagination
    const totalPages = Math.ceil(count / PAGE_SIZE);
    if (totalPages > 1) {
      paginationEl.style.display = 'flex';
      document.getElementById('pageInfo').textContent = `Page ${currentPage} of ${totalPages}`;
      document.getElementById('prevBtn').disabled = currentPage <= 1;
      document.getElementById('nextBtn').disabled = currentPage >= totalPages;
    }

  } catch (e) {
    loadingEl.style.display = 'none';
    errorEl.style.display = 'block';
    errorEl.textContent = `Failed to load transcripts: ${e.message}`;
  }
}

// Render user's own transcripts
function renderMyTranscripts(transcripts) {
  const listEl = document.getElementById('transcriptList');

  transcripts.forEach(t => {
    const card = document.createElement('a');
    card.className = 'transcript-card';
    card.href = `transcript.html?id=${t.id}`;
    card.target = '_blank';

    const icon = getSourceIcon(t.source_type);
    const date = new Date(t.created_at).toLocaleDateString();
    const words = t.word_count ? `${t.word_count.toLocaleString()} words` : '';
    const lang = t.language ? t.language.toUpperCase() : '';

    let badges = '';
    if (t.is_public) {
      badges += '<span class="card-badge badge-public">Public</span>';
    }

    card.innerHTML = `
      <div class="card-icon">${icon}</div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(t.title || 'Untitled')}</div>
        <div class="card-meta">
          <span>${date}</span>
          ${t.duration_display ? `<span>${t.duration_display}</span>` : ''}
          ${words ? `<span>${words}</span>` : ''}
          ${lang ? `<span>${lang}</span>` : ''}
        </div>
      </div>
      ${badges}
    `;

    listEl.appendChild(card);
  });
}

// Render transcripts shared with the user
function renderSharedTranscripts(shares) {
  const listEl = document.getElementById('transcriptList');

  shares.forEach(share => {
    const t = share.transcript;
    if (!t) return;

    const card = document.createElement('a');
    card.className = 'transcript-card';
    card.href = `transcript.html?id=${t.id}`;
    card.target = '_blank';

    const icon = getSourceIcon(t.source_type);
    const date = new Date(t.created_at).toLocaleDateString();
    const sharedBy = share.shared_by?.display_name || share.shared_by?.email || 'Someone';
    const permission = share.permission === 'write' ? 'Can edit' : 'View only';

    card.innerHTML = `
      <div class="card-icon">${icon}</div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(t.title || 'Untitled')}</div>
        <div class="card-meta">
          <span>${date}</span>
          ${t.duration_display ? `<span>${t.duration_display}</span>` : ''}
          ${t.word_count ? `<span>${t.word_count.toLocaleString()} words</span>` : ''}
        </div>
        <div class="shared-info">Shared by ${escapeHtml(sharedBy)} &middot; ${permission}</div>
      </div>
      <span class="card-badge badge-shared">${permission}</span>
    `;

    listEl.appendChild(card);
  });
}

// Get icon based on source type
function getSourceIcon(sourceType) {
  switch (sourceType) {
    case 'url': return '🔗';
    case 'file': return '📁';
    case 'recording': return '🎙️';
    case 'youtube_transcript': return '⚡';
    default: return '📄';
  }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

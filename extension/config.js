// Voxly - Shared Configuration
// Single source of truth for constants used across the extension.

// Version — read from manifest.json so there's only one place to update
const CURRENT_VERSION = chrome.runtime.getManifest().version;

// Free tier
const FREE_LIMIT = 15;

// Polling & timing (ms)
const DEBOUNCE_DELAY_MS = 600;
const STATUS_MESSAGE_TIMEOUT_MS = 3000;

// Transcript formatting
const MAX_SEGMENTS_PER_PARAGRAPH = 6;
const TIME_GAP_THRESHOLD_S = 10;
const SUMMARY_PREVIEW_LENGTH = 200;

// OpenAI
const OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_MAX_TOKENS = 1500;

// GitHub
const GITHUB_REPO = 'outerbanks73/speaktotext-local';

// Supabase (cloud features — premium, opt-in)
const SUPABASE_URL = 'https://ohxuifdseybxckmprcry.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_8LuIdBPmXssVwNnM_rhOMQ__U7ExMGA';
const SUPABASE_FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

// Deepgram (realtime streaming)
const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

// Populate version tags in HTML pages (runs in document contexts, not service workers)
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.version-tag').forEach(el => {
      el.textContent = `v${CURRENT_VERSION}`;
    });
  });
}

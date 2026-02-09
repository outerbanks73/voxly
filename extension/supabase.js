// Voxly - Supabase Client Singleton
// Provides a single Supabase client instance with a chrome.storage.local adapter
// for session persistence (service workers cannot use localStorage).

let _supabaseClient = null;

// Custom storage adapter that wraps chrome.storage.local for supabase-js auth.
// supabase-js expects a synchronous-looking getItem/setItem/removeItem interface,
// but chrome.storage.local is async. supabase-js v2+ handles async storage adapters.
const chromeStorageAdapter = {
  async getItem(key) {
    const result = await chrome.storage.local.get([key]);
    return result[key] || null;
  },
  async setItem(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async removeItem(key) {
    await chrome.storage.local.remove([key]);
  }
};

function getSupabase() {
  if (_supabaseClient) return _supabaseClient;

  // supabase global is provided by lib/supabase.min.js (UMD)
  _supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: chromeStorageAdapter,
      storageKey: 'voxly-supabase-auth',
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false  // We handle OAuth redirects manually
    }
  });

  return _supabaseClient;
}

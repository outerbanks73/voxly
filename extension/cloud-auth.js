// Voxly - Cloud Authentication
// Handles OAuth login/logout, session management, and auth state broadcasting.
// Uses chrome.identity.launchWebAuthFlow() for OAuth providers.

// Get current cloud user, or null if not logged in
async function getCloudUser() {
  const sb = getSupabase();
  const { data: { user } } = await sb.auth.getUser();
  return user;
}

// Check if user is authenticated with Supabase
async function isCloudAuthenticated() {
  const user = await getCloudUser();
  return !!user;
}

// Get current session (access_token, refresh_token, etc.)
async function getCloudSession() {
  const sb = getSupabase();
  const { data: { session } } = await sb.auth.getSession();
  return session;
}

// Check if user can use cloud features (premium + logged in)
async function canUseCloudFeatures() {
  const premium = await isPremiumUser();
  const loggedIn = await isCloudAuthenticated();
  return premium && loggedIn;
}

// Sign in with OAuth provider (Google, GitHub)
async function cloudSignInWithOAuth(provider) {
  const sb = getSupabase();
  const redirectUrl = chrome.identity.getRedirectURL();

  // Build the Supabase OAuth URL
  const { data, error } = await sb.auth.signInWithOAuth({
    provider: provider,
    options: {
      redirectTo: redirectUrl,
      skipBrowserRedirect: true  // We handle the redirect ourselves
    }
  });

  if (error) throw error;

  // Use chrome.identity to handle the OAuth flow in a popup
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: data.url, interactive: true },
      async (responseUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!responseUrl) {
          reject(new Error('No response URL from auth flow'));
          return;
        }

        try {
          // Parse tokens from the redirect URL hash fragment
          const url = new URL(responseUrl);
          const hashParams = new URLSearchParams(url.hash.substring(1));
          const accessToken = hashParams.get('access_token');
          const refreshToken = hashParams.get('refresh_token');

          if (!accessToken || !refreshToken) {
            reject(new Error('Missing tokens in auth response'));
            return;
          }

          // Set the session in Supabase client
          const { data: sessionData, error: sessionError } = await sb.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken
          });

          if (sessionError) {
            reject(sessionError);
            return;
          }

          // Broadcast auth state change
          await broadcastAuthStateChange(sessionData.user);
          resolve(sessionData.user);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

// Sign in with email and password
async function cloudSignInWithEmail(email, password) {
  const sb = getSupabase();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  await broadcastAuthStateChange(data.user);
  return data.user;
}

// Sign up with email and password
async function cloudSignUpWithEmail(email, password) {
  const sb = getSupabase();
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;
  if (data.user) await broadcastAuthStateChange(data.user);
  return data;
}

// Sign in with magic link (passwordless)
async function cloudSignInWithMagicLink(email) {
  const sb = getSupabase();
  const redirectUrl = chrome.identity.getRedirectURL();
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectUrl }
  });
  if (error) throw error;
  return { message: 'Check your email for the login link' };
}

// Sign out
async function cloudSignOut() {
  const sb = getSupabase();
  await sb.auth.signOut();
  await chrome.storage.local.remove(['cloudAuthState']);
  broadcastAuthStateChange(null);
}

// Refresh session (called by background alarm)
async function refreshCloudSession() {
  const sb = getSupabase();
  const { data, error } = await sb.auth.refreshSession();
  if (error) {
    console.log('Session refresh failed:', error.message);
    return null;
  }
  return data.session;
}

// Broadcast auth state change to all extension contexts
async function broadcastAuthStateChange(user) {
  const state = user ? {
    userId: user.id,
    email: user.email,
    displayName: user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0],
    avatarUrl: user.user_metadata?.avatar_url || null
  } : null;

  await chrome.storage.local.set({ cloudAuthState: state });

  // Notify all open extension contexts
  try {
    chrome.runtime.sendMessage({ action: 'cloudAuthStateChanged', user: state });
  } catch (e) {
    // No listeners — that's fine
  }
}

// Load cached auth state (fast, avoids network call)
async function getCachedCloudAuthState() {
  const { cloudAuthState } = await chrome.storage.local.get(['cloudAuthState']);
  return cloudAuthState || null;
}

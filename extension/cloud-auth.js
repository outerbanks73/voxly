// Voxly - Cloud Authentication
// Handles OAuth login/logout, session management, and auth state broadcasting.
// Uses chrome.windows.create() popup for OAuth providers.

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

// Ensure we have a valid, fresh session before API calls.
// Returns a valid session or null (if user needs to re-authenticate).
async function ensureValidSession() {
  const sb = getSupabase();

  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;

  // Check if the access token is expired or expiring within 60s
  try {
    const payload = JSON.parse(atob(session.access_token.split('.')[1]));
    const expiresAt = payload.exp * 1000;
    if (expiresAt - Date.now() > 60000) {
      // Token still valid
      return session;
    }
  } catch (e) {
    // JWT decode failed — force refresh
  }

  // Token expired or expiring — try to refresh
  console.log('[Voxly] Access token expired, refreshing session...');
  try {
    const { data, error } = await sb.auth.refreshSession();
    if (error || !data.session) {
      console.error('[Voxly] Session refresh failed:', error?.message || 'no session returned');
      // Session is unrecoverable — clear it so UI shows "sign in"
      await cloudSignOut();
      return null;
    }
    console.log('[Voxly] Session refreshed successfully');
    return data.session;
  } catch (e) {
    console.error('[Voxly] Session refresh threw:', e.message);
    await cloudSignOut();
    return null;
  }
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
  // Use chromiumapp.org redirect (already whitelisted in Supabase)
  const redirectUrl = `https://${chrome.runtime.id}.chromiumapp.org/`;

  // Build the Supabase OAuth URL
  const { data, error } = await sb.auth.signInWithOAuth({
    provider: provider,
    options: {
      redirectTo: redirectUrl,
      skipBrowserRedirect: true  // We handle the redirect ourselves
    }
  });

  if (error) throw error;

  // Open a compact popup window for the OAuth flow
  return new Promise((resolve, reject) => {
    let authWindowId = null;
    let settled = false;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      chrome.windows.onRemoved.removeListener(onWindowRemoved);
    };

    // Watch for the tab navigating to the redirect URL (contains tokens in hash)
    const onTabUpdated = async (tabId, changeInfo, tab) => {
      if (!authWindowId || tab.windowId !== authWindowId) return;

      // Use tab.url (includes hash fragment) with fallback to changeInfo.url
      const url = tab.url || changeInfo.url || '';
      if (!url.startsWith(redirectUrl)) return;

      if (settled) return;
      settled = true;
      cleanup();

      // Close the auth popup
      chrome.windows.remove(authWindowId).catch(() => {});

      try {
        const parsedUrl = new URL(url);
        const hashParams = new URLSearchParams(parsedUrl.hash.substring(1));
        const accessToken = hashParams.get('access_token');
        const refreshToken = hashParams.get('refresh_token');

        if (!accessToken || !refreshToken) {
          reject(new Error('Missing tokens in auth response'));
          return;
        }

        const { data: sessionData, error: sessionError } = await sb.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken
        });

        if (sessionError) {
          reject(sessionError);
          return;
        }

        await broadcastAuthStateChange(sessionData.user);
        resolve(sessionData.user);
      } catch (e) {
        reject(e);
      }
    };

    // Handle user closing the popup without completing auth
    const onWindowRemoved = (windowId) => {
      if (windowId !== authWindowId) return;
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Sign-in cancelled'));
    };

    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.windows.onRemoved.addListener(onWindowRemoved);

    // Open a compact popup window (500x700) instead of full browser window
    const width = 500;
    const height = 700;
    const createOptions = {
      url: data.url,
      type: 'popup',
      width,
      height
    };

    if (typeof screen !== 'undefined') {
      createOptions.left = Math.round((screen.availWidth - width) / 2);
      createOptions.top = Math.round((screen.availHeight - height) / 2);
    }

    chrome.windows.create(createOptions, (win) => {
      if (chrome.runtime.lastError) {
        cleanup();
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      authWindowId = win.id;
    });
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
  const redirectUrl = `https://${chrome.runtime.id}.chromiumapp.org/`;
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

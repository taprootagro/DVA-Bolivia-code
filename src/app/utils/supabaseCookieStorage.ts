/**
 * supabaseCookieStorage — hybrid localStorage + cookie storage adapter
 * for Supabase Auth's `storage` option.
 *
 * Motivation:
 *   In PWA standalone mode on iOS, the OAuth PKCE code_verifier is stored in
 *   the PWA's localStorage — a separate browsing context from the system
 *   Safari that handles the OAuth redirect.  The callback arrives in Safari
 *   and cannot read the PWA's localStorage → "PKCE code verifier not found".
 *
 *   Cookies are shared across all browsing contexts (PWA standalone, system
 *   browser tabs) on the same domain, so writing both to localStorage AND
 *   cookies makes the verifier (and the resulting session) available wherever
 *   the callback lands.
 *
 * Strategy:
 *   - getItem:  localStorage first (fast, same-context), fallback to cookie for PKCE keys
 *   - setItem:  localStorage always; cookie only for PKCE verifier (OAuth cross-context)
 *   - removeItem: remove from BOTH
 */

const COOKIE_PREFIX = "tap_sb_"; // avoid collisions with other cookies
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function shouldMirrorToCookie(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.includes('code-verifier') || lower.includes('code_verifier') || lower.includes('pkce');
}

function _setCookie(name: string, value: string): void {
  const encoded = encodeURIComponent(value);
  document.cookie =
    `${COOKIE_PREFIX}${name}=${encoded}; path=/; secure; SameSite=Lax; max-age=${COOKIE_MAX_AGE}`;
}

function _getCookie(name: string): string | null {
  const prefix = `${COOKIE_PREFIX}${name}=`;
  const cookies = document.cookie.split("; ");
  for (const c of cookies) {
    if (c.startsWith(prefix)) {
      const raw = c.slice(prefix.length);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

function _removeCookie(name: string): void {
  document.cookie = `${COOKIE_PREFIX}${name}=; path=/; secure; SameSite=Lax; max-age=0`;
}

export const supabaseCookieStorage = {
  getItem(key: string): string | null {
    // fast path — same browsing context
    try {
      const ls = localStorage.getItem(key);
      if (ls !== null) return ls;
    } catch {
      /* localStorage may throw in private browsing / full quota */
    }

    // cross-context fallback — cookie is shared between PWA & system browser (PKCE only)
    if (!shouldMirrorToCookie(key)) return null;
    try {
      return _getCookie(key);
    } catch {
      return null;
    }
  },

  setItem(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* noop — cookie write below is the critical path for PKCE survival */
    }

    if (!shouldMirrorToCookie(key)) return;

    try {
      _setCookie(key, value);
    } catch {
      /* cookie write may fail in restricted environments */
    }
  },

  removeItem(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }

    try {
      _removeCookie(key);
    } catch {
      /* noop */
    }
  },
};

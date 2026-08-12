// ============================================================================
// Auth Utilities — Login State + User ID Management
// ============================================================================
// User ID assignment follows a two-tier strategy:
//
//   Tier 1 (Production — Backend Enabled):
//     Login → Supabase Auth verifies credentials → returns server-assigned
//     user.id (UUID) → stored locally → used as IM identity.
//     The server-assigned ID is cryptographically random, globally unique,
//     and cannot be forged by the client. The Edge Function's /auth endpoint
//     is the single source of truth.
//
//   Tier 2 (Template Demo — No Backend):
//     Login → client generates a 10-digit numeric ID locally.
//     This is ONLY for white-label template preview / offline demo.
//     It provides no security guarantees.
//
// ID storage keys:
//   - SERVER_USER_ID_KEY: server-assigned ID (takes priority)
//   - NUMERIC_ID_KEY:     locally generated fallback
//
// The IM registration flow uses whichever ID is available (server > local).
// ============================================================================

const LOGIN_KEY = "isLoggedIn";
const NUMERIC_ID_KEY = "agri_user_numeric_id";
const SERVER_USER_ID_KEY = "agri_server_user_id";
const AUTH_SOURCE_KEY = "agri_auth_source"; // "server" | "local"
const ACCESS_TOKEN_KEY = "agri_access_token"; // JWT from Supabase Auth

import { mirrorAuthToDexie, mirrorSupabaseSessionToDexie, getSupabaseSessionBackupFromDexie, SUPABASE_AUTH_STORAGE_KEY } from './db';
import { storageGet, storageSet, storageRemove } from './safeStorage';
import { getSupabaseBrowserClient } from './supabaseBrowser';
import { clearLinkedGoogleCache } from './linkedGoogleCache';
import { clearProfileEditCooldown } from './profileEditCooldown';
import { clearCommunityRoleCache, clearStoreShellState } from './chatTabPersistence';
import { clearEdgeProfileCache } from './edgeProfileCache';

/** 登录状态写入 storage 后广播；Layout keep-alive 下页面不会卸载，需监听以刷新 UI */
export const TAPROOT_AUTH_CHANGE_EVENT = "taproot-auth-change";

/** Supabase Session 子集 — 用于 access_token 新鲜度判断 */
export type SessionFreshnessInput = {
  access_token?: string | null;
  expires_at?: number | null;
  refresh_token?: string | null;
  user?: { id?: string } | null;
};

/** Re-export for storage listeners / SW backup lists */
export { SUPABASE_AUTH_STORAGE_KEY };

const DEFAULT_TOKEN_SKEW_SEC = 60;
/** heartbeat / 同步路径：距过期 ≤ 15min 即主动 refresh，降低 PWA 节流错过窗口 */
const REFRESH_PROACTIVE_SEC = 15 * 60;
const REFRESH_RETRY_DELAYS_MS = [1000, 3000, 8000] as const;

export type EdgeSessionFailureKind = 'none' | 'transient' | 'permanent';

type RefreshSessionResult =
  | { ok: true; session: SessionFreshnessInput }
  | { ok: false; kind: 'permanent' | 'transient' };

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Permanent refresh failure — user must re-authenticate. */
export function isRefreshTokenPermanentFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const msg = String((error as { message?: string }).message ?? '').toLowerCase();
  const code = String((error as { code?: string }).code ?? '').toLowerCase();
  if (code === 'invalid_grant') return true;
  if (msg.includes('invalid_grant')) return true;
  if (msg.includes('refresh_token_not_found')) return true;
  if (msg.includes('invalid refresh token')) return true;
  if (msg.includes('session not found')) return true;
  if (msg.includes('user not found')) return true;
  return false;
}

function sessionNeedsProactiveRefresh(
  session: SessionFreshnessInput | null | undefined,
): boolean {
  if (!session?.refresh_token) return false;
  if (!session.access_token) return true;
  const expiresAt = session.expires_at;
  if (expiresAt == null || !Number.isFinite(expiresAt)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return expiresAt <= nowSec + REFRESH_PROACTIVE_SEC;
}

function applySessionToLocalAuth(session: SessionFreshnessInput): void {
  if (session.access_token) {
    storageSet(ACCESS_TOKEN_KEY, session.access_token);
    mirrorSupabaseSessionToDexie().catch(() => {});
  }
  if (session.user?.id) {
    if (!getServerUserId()) setServerUserId(session.user.id);
    if (!isUserLoggedIn()) setUserLoggedIn(true);
  }
}

async function refreshSupabaseSessionOnce(): Promise<RefreshSessionResult> {
  const client = getSupabaseBrowserClient();
  if (!client) return { ok: false, kind: 'transient' };
  try {
    const { data, error } = await client.auth.refreshSession();
    if (data.session?.access_token) {
      applySessionToLocalAuth(data.session);
      return { ok: true, session: data.session };
    }
    if (error) {
      return {
        ok: false,
        kind: isRefreshTokenPermanentFailure(error) ? 'permanent' : 'transient',
      };
    }
    return { ok: false, kind: 'permanent' };
  } catch {
    return { ok: false, kind: 'transient' };
  }
}

async function refreshSupabaseSessionWithRetry(): Promise<RefreshSessionResult> {
  let last: RefreshSessionResult = { ok: false, kind: 'transient' };
  for (let i = 0; i <= REFRESH_RETRY_DELAYS_MS.length; i++) {
    if (i > 0) await sleepMs(REFRESH_RETRY_DELAYS_MS[i - 1]!);
    last = await refreshSupabaseSessionOnce();
    if (last.ok) return last;
    if (last.kind === 'permanent') return last;
  }
  return last;
}

/** @deprecated internal — use refreshSupabaseSessionWithRetry */
async function refreshSupabaseSession(): Promise<SessionFreshnessInput | null> {
  const result = await refreshSupabaseSessionWithRetry();
  return result.ok ? result.session : null;
}

/**
 * Restore Supabase session from Dexie when localStorage taprootagro-auth is missing.
 */
export async function hydrateSessionFromBackup(): Promise<boolean> {
  if (storageGet(SUPABASE_AUTH_STORAGE_KEY)) return false;
  const client = getSupabaseBrowserClient();
  if (!client) return false;

  const backup = await getSupabaseSessionBackupFromDexie();
  if (!backup) return false;

  try {
    const parsed = JSON.parse(backup) as Record<string, unknown>;
    const access_token =
      (typeof parsed.access_token === 'string' ? parsed.access_token : null) ||
      (typeof (parsed.currentSession as { access_token?: string } | undefined)?.access_token === 'string'
        ? (parsed.currentSession as { access_token: string }).access_token
        : null);
    const refresh_token =
      (typeof parsed.refresh_token === 'string' ? parsed.refresh_token : null) ||
      (typeof (parsed.currentSession as { refresh_token?: string } | undefined)?.refresh_token === 'string'
        ? (parsed.currentSession as { refresh_token: string }).refresh_token
        : null);
    if (!access_token || !refresh_token) return false;

    storageSet(SUPABASE_AUTH_STORAGE_KEY, backup);
    const { data, error } = await client.auth.setSession({ access_token, refresh_token });
    if (error || !data.session?.access_token) return false;
    applySessionToLocalAuth(data.session);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when session has a non-expired access_token (with skew buffer).
 * Missing expires_at: treat as fresh if access_token exists (legacy/demo edge).
 */
export function isSessionAccessTokenFresh(
  session: SessionFreshnessInput | null | undefined,
  skewSec = DEFAULT_TOKEN_SKEW_SEC,
): boolean {
  if (!session?.access_token) return false;
  const expiresAt = session.expires_at;
  if (expiresAt == null || !Number.isFinite(expiresAt)) return true;
  const nowSec = Math.floor(Date.now() / 1000);
  return expiresAt > nowSec + skewSec;
}

/**
 * Check if user is logged in
 */
export function isUserLoggedIn(): boolean {
  return storageGet(LOGIN_KEY) === "true";
}

function dispatchTaprootAuthChanged(): void {
  try {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new Event(TAPROOT_AUTH_CHANGE_EVENT));
  } catch {
    /* ignore */
  }
}

/**
 * Set user login status.
 * When logging in (status=true) WITHOUT a server ID, generates a local fallback.
 * When logging out (status=false), preserves IDs for potential re-login.
 *
 * For server-assigned IDs, call setServerUserId() BEFORE setUserLoggedIn(true).
 */
export function setUserLoggedIn(status: boolean): void {
  if (status) {
    storageSet(LOGIN_KEY, "true");
    // If no server ID was set before this call, generate a local fallback
    if (!getServerUserId() && !getLocalNumericId()) {
      const newId = generateNumericId();
      storageSet(NUMERIC_ID_KEY, newId);
      storageSet(AUTH_SOURCE_KEY, "local");
      console.log(`[Auth] Local fallback ID generated: ${newId} (no backend)`);
    }
    // Mirror to encrypted Dexie backup (fire-and-forget)
    mirrorAuthToDexie().catch(() => {});
  } else {
    storageRemove(LOGIN_KEY);
    // Preserve IDs so re-login retains the same IM identity
    mirrorAuthToDexie().catch(() => {});
  }
  dispatchTaprootAuthChanged();
}

// ---- Server-Assigned ID (Tier 1 — Production) ----

/**
 * Store a server-assigned user ID (from Supabase Auth via Edge Function).
 * This MUST be called before setUserLoggedIn(true) when backend is available.
 *
 * @param id - The user.id UUID returned by Supabase Auth
 */
export function setServerUserId(id: string): void {
  storageSet(SERVER_USER_ID_KEY, id);
  storageSet(AUTH_SOURCE_KEY, "server");
  console.log(`[Auth] Server-assigned user ID stored: ${id}`);
  // Mirror to encrypted Dexie backup (fire-and-forget)
  mirrorAuthToDexie().catch(() => {});
}

/**
 * Get the server-assigned user ID (null if not set / using local fallback)
 */
export function getServerUserId(): string | null {
  return storageGet(SERVER_USER_ID_KEY);
}

/**
 * Check whether the current ID was assigned by the server (secure) or
 * generated locally (insecure demo mode).
 */
export function isServerAssignedId(): boolean {
  return storageGet(AUTH_SOURCE_KEY) === "server";
}

// ---- Access Token (JWT for API Authorization) ----

/**
 * Store the access token (JWT) returned by Supabase Auth.
 * This token is sent as `Authorization: Bearer <token>` in API requests,
 * allowing the backend to verify the user's identity via `auth.getUser(token)`.
 *
 * @param token - JWT access token from Supabase Auth
 */
export function setAccessToken(token: string): void {
  storageSet(ACCESS_TOKEN_KEY, token);
  mirrorSupabaseSessionToDexie().catch(() => {});
  console.log(`[Auth] Access token stored (${token.slice(0, 20)}...)`);
}

/**
 * Get the stored access token (null if not set / demo mode).
 * When present, this should be used for Authorization headers instead of anonKey.
 */
export function getAccessToken(): string | null {
  return storageGet(ACCESS_TOKEN_KEY);
}

/**
 * Pull the current JWT from Supabase Auth (local session / refresh) into agri_access_token.
 * Supabase only persists its own sb-*-auth-token; without this, Edge calls still send a stale
 * copy from agri_access_token → gateway 401 → NOT_LOGGED_IN while the UI shows logged in.
 */
export async function syncAccessTokenFromSupabaseSession(): Promise<void> {
  try {
    await hydrateSessionFromBackup();
    const client = getSupabaseBrowserClient();
    if (!client) return;
    const { data: { session } } = await client.auth.getSession();

    let activeSession = session;
    if (session?.refresh_token && sessionNeedsProactiveRefresh(session)) {
      const refreshed = await refreshSupabaseSessionWithRetry();
      if (refreshed.ok) activeSession = refreshed.session as typeof session;
    }

    if (activeSession?.access_token && isSessionAccessTokenFresh(activeSession)) {
      setAccessToken(activeSession.access_token);
      if (!isUserLoggedIn() && activeSession.user?.id) {
        setServerUserId(activeSession.user.id);
        setUserLoggedIn(true);
      }
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Edge GET/POST：优先使用 Supabase Auth 当前 session 的 access_token，并写回 agri_access_token。
 * 避免仅用 localStorage 里的旧 JWT → 401 → 刷新资料失败，看起来像「没同步」且界面闪一下。
 *
 * 在 access_token 即将过期时主动 refreshSession，减少「界面仍显示已登录但 Edge 已拒 token」的窗口。
 */
export async function getSessionAccessTokenForEdge(): Promise<string | null> {
  const result = await getSessionAccessTokenForEdgeDetailed();
  return result.token;
}

async function getSessionAccessTokenForEdgeDetailed(): Promise<{
  token: string | null;
  failureKind: EdgeSessionFailureKind;
}> {
  const client = getSupabaseBrowserClient();
  if (!client) return { token: getAccessToken(), failureKind: 'none' };

  try {
    await hydrateSessionFromBackup();
    const { data: first } = await client.auth.getSession();
    let session = first.session;
    let lastFailure: EdgeSessionFailureKind = 'none';

    if (session?.refresh_token && sessionNeedsProactiveRefresh(session)) {
      const refreshed = await refreshSupabaseSessionWithRetry();
      if (refreshed.ok) {
        session = refreshed.session as typeof session;
      } else {
        lastFailure = refreshed.kind === 'permanent' ? 'permanent' : 'transient';
      }
    }

    if (session?.access_token && isSessionAccessTokenFresh(session)) {
      setAccessToken(session.access_token);
      return { token: session.access_token, failureKind: 'none' };
    }

    if (!session?.refresh_token) {
      return { token: null, failureKind: 'permanent' };
    }

    const afterRefresh = await refreshSupabaseSessionWithRetry();
    if (
      afterRefresh.ok &&
      afterRefresh.session.access_token &&
      isSessionAccessTokenFresh(afterRefresh.session)
    ) {
      setAccessToken(afterRefresh.session.access_token);
      return { token: afterRefresh.session.access_token, failureKind: 'none' };
    }
    const kind: EdgeSessionFailureKind =
      afterRefresh.ok ? 'transient' : afterRefresh.kind === 'permanent' ? 'permanent' : 'transient';
    return { token: null, failureKind: lastFailure !== 'none' ? lastFailure : kind };
  } catch {
    return { token: null, failureKind: 'transient' };
  }
}

/**
 * 打开 App / 进 AI / Edge 请求前：静默续期，返回 fresh access_token 与失败类型。
 */
export async function ensureEdgeSessionReadyDetailed(): Promise<{
  token: string | null;
  failureKind: EdgeSessionFailureKind;
}> {
  await hydrateSessionFromBackup();
  await syncAccessTokenFromSupabaseSession();
  const first = await getSessionAccessTokenForEdgeDetailed();
  if (first.token) return first;

  const refreshed = await refreshSupabaseSessionWithRetry();
  if (
    refreshed.ok &&
    refreshed.session.access_token &&
    isSessionAccessTokenFresh(refreshed.session)
  ) {
    setAccessToken(refreshed.session.access_token);
    return { token: refreshed.session.access_token, failureKind: 'none' };
  }

  if (refreshed.ok) {
    return { token: null, failureKind: 'transient' };
  }
  return {
    token: null,
    failureKind: refreshed.kind === 'permanent' ? 'permanent' : first.failureKind,
  };
}

/**
 * 打开 App / 进 AI / Edge 请求前：静默续期，返回 fresh access_token。
 * refresh_token 仍有效时农户无感；失效时返回 null（需重新登录）。
 */
export async function ensureEdgeSessionReady(): Promise<string | null> {
  const { token } = await ensureEdgeSessionReadyDetailed();
  return token;
}

/**
 * Clear the access token (e.g., on logout or token expiry).
 */
export function clearAccessToken(): void {
  storageRemove(ACCESS_TOKEN_KEY);
}

// ---- Effective User ID (used by IM services) ----

/**
 * Get the user's effective ID for IM communication.
 * Priority: server-assigned UUID > locally generated numeric ID > null
 */
export function getUserId(): string | null {
  return getServerUserId() || getLocalNumericId();
}

/**
 * @deprecated Use getUserId() instead. Kept for backward compatibility.
 * Returns the locally generated numeric ID (null if never generated).
 */
export function getNumericUserId(): string | null {
  // Return effective ID (server > local) for backward compatibility
  return getUserId();
}

/**
 * Get ONLY the locally generated numeric ID (ignoring server ID).
 * Used internally and for migration scenarios.
 */
export function getLocalNumericId(): string | null {
  return storageGet(NUMERIC_ID_KEY);
}

/**
 * Generate a 10-digit unique numeric ID (local fallback only).
 * Format: 6 timestamp-derived digits + 4 random digits
 */
function generateNumericId(): string {
  const timePart = (Date.now() % 1_000_000_000).toString().padStart(9, "0").slice(0, 6);
  const randPart = Math.floor(1000 + Math.random() * 9000).toString();
  return timePart + randPart;
}

/**
 * Clear all auth data (login status + all IDs).
 * Use this for "delete account" scenarios.
 */
export function clearAuthData(): void {
  storageRemove(LOGIN_KEY);
  storageRemove(NUMERIC_ID_KEY);
  storageRemove(SERVER_USER_ID_KEY);
  storageRemove(AUTH_SOURCE_KEY);
  storageRemove(ACCESS_TOKEN_KEY);
  clearLinkedGoogleCache();
  clearProfileEditCooldown();
  clearCommunityRoleCache();
  clearStoreShellState();
  clearEdgeProfileCache();
  // Mirror cleared state to Dexie
  mirrorAuthToDexie().catch(() => {});
}

/**
 * Check if login is required; if not logged in, navigate to login page.
 */
export function requireLogin(
  navigate: (path: string) => void,
  callback?: () => void
): boolean {
  const loggedIn = isUserLoggedIn();

  if (!loggedIn) {
    navigate("/login");
    return false;
  }

  if (callback) {
    callback();
  }

  return true;
}
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { app as capApp, browser, isNative } from '../utils/capacitor-bridge';

const OAUTH_CALLBACK_PATH = '/auth/callback';
const OAUTH_CALLBACK_HOST = 'auth';
const OAUTH_CALLBACK_SCHEME_PATH = '/callback';

function schemeRedirect(appId: string): string {
  return `${appId}://${OAUTH_CALLBACK_HOST}${OAUTH_CALLBACK_SCHEME_PATH}`;
}

/** Capacitor 运行时 getConfig().appId 经常为空，需同时读 Config / 构建期注入。 */
export function readNativeAppId(): string | null {
  const envId = String(import.meta.env.VITE_CAPACITOR_APP_ID ?? '').trim();
  if (envId) return envId;
  if (typeof window === 'undefined') return null;
  try {
    const cap = (window as any).Capacitor;
    const raw =
      cap?.getConfig?.()?.appId ||
      cap?.Config?.appId ||
      cap?.config?.appId ||
      '';
    const id = String(raw).trim();
    return id || null;
  } catch {
    return null;
  }
}

/** Native OAuth redirect — must match AndroidManifest scheme + Supabase Redirect URLs. */
export function nativeOAuthRedirectTo(): string {
  if (typeof window !== 'undefined' && isNative()) {
    const appId = readNativeAppId();
    if (appId) return schemeRedirect(appId);
    // Native 禁止回退到 https://localhost（Custom Tabs 会当网页打开，无法回 App）
    return '';
  }
  if (typeof window !== 'undefined') {
    return `${window.location.origin}${OAUTH_CALLBACK_PATH}`;
  }
  return OAUTH_CALLBACK_PATH;
}

/** Native：同步读不到 appId 时再问 App.getInfo().id（系统包名）。 */
export async function resolveNativeOAuthRedirectTo(): Promise<string> {
  const sync = nativeOAuthRedirectTo();
  if (!isNative()) return sync;
  if (sync) return sync;
  const packageId = await capApp.getId();
  if (packageId) return schemeRedirect(packageId);
  return '';
}

function isOAuthCallbackUrl(parsed: URL): boolean {
  if (parsed.host === OAUTH_CALLBACK_HOST && parsed.pathname === OAUTH_CALLBACK_SCHEME_PATH) {
    return true;
  }
  return parsed.pathname === OAUTH_CALLBACK_PATH || parsed.pathname.endsWith(OAUTH_CALLBACK_PATH);
}

/** Deep link / Custom Tabs 回调 URL → React Router 路径（含 query/hash） */
export function oauthCallbackRouteFromUrl(url: string): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;

  const hasSchemeCallback =
    trimmed.includes('://auth/callback') ||
    trimmed.includes(`://${OAUTH_CALLBACK_HOST}${OAUTH_CALLBACK_SCHEME_PATH}`);

  if (!hasSchemeCallback && !trimmed.includes(OAUTH_CALLBACK_PATH)) {
    return null;
  }

  try {
    const parsed = new URL(
      trimmed,
      typeof window !== 'undefined' ? window.location.origin : 'https://localhost',
    );
    if (!isOAuthCallbackUrl(parsed)) return null;
    return `${OAUTH_CALLBACK_PATH}${parsed.search}${parsed.hash}`;
  } catch {
    if (!hasSchemeCallback && !trimmed.includes(OAUTH_CALLBACK_PATH)) return null;
    const idx = trimmed.indexOf(OAUTH_CALLBACK_PATH);
    if (idx >= 0) {
      return trimmed.slice(idx);
    }
    const schemeIdx = trimmed.indexOf(`://${OAUTH_CALLBACK_HOST}${OAUTH_CALLBACK_SCHEME_PATH}`);
    if (schemeIdx >= 0) {
      const suffix = trimmed.slice(schemeIdx + `://${OAUTH_CALLBACK_HOST}${OAUTH_CALLBACK_SCHEME_PATH}`.length);
      return `${OAUTH_CALLBACK_PATH}${suffix}`;
    }
    return null;
  }
}

/**
 * Capacitor：监听 OAuth deep link（包名 scheme），关闭 Custom Tabs 并交给 /auth/callback 换票。
 */
export function useNativeOAuthCallback() {
  const navigate = useNavigate();
  const handledLaunchUrl = useRef(false);
  const lastHandledUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!isNative()) return;

    const handleOAuthUrl = async (url: string) => {
      const route = oauthCallbackRouteFromUrl(url);
      if (!route) return;
      if (lastHandledUrl.current === url) return;
      lastHandledUrl.current = url;

      await browser.close();
      navigate(route, { replace: true });
    };

    let removeListener: (() => void) | undefined;

    void capApp.onAppUrlOpen((url) => {
      void handleOAuthUrl(url);
    }).then((unsub) => {
      removeListener = unsub;
    });

    if (!handledLaunchUrl.current) {
      handledLaunchUrl.current = true;
      void capApp.getLaunchUrl().then((url) => {
        if (url) void handleOAuthUrl(url);
      });
    }

    return () => {
      removeListener?.();
    };
  }, [navigate]);
}

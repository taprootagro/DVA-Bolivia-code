import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { app as capApp, browser, isNative } from '../utils/capacitor-bridge';

const OAUTH_CALLBACK_SEGMENT = '/auth/callback';

/** Custom Tabs 回调 URL → React Router 路径（含 query/hash） */
export function oauthCallbackRouteFromUrl(url: string): string | null {
  const trimmed = url?.trim();
  if (!trimmed || !trimmed.includes(OAUTH_CALLBACK_SEGMENT)) return null;

  try {
    const parsed = new URL(trimmed, typeof window !== 'undefined' ? window.location.origin : 'https://localhost');
    if (!parsed.pathname.includes(OAUTH_CALLBACK_SEGMENT)) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    const suffix = trimmed.slice(trimmed.indexOf(OAUTH_CALLBACK_SEGMENT) + OAUTH_CALLBACK_SEGMENT.length);
    return `${OAUTH_CALLBACK_SEGMENT}${suffix}`;
  }
}

/**
 * Capacitor：监听 OAuth deep link，关闭 Custom Tabs 并交给 /auth/callback 换票。
 */
export function useNativeOAuthCallback() {
  const navigate = useNavigate();
  const handledLaunchUrl = useRef(false);

  useEffect(() => {
    if (!isNative()) return;

    const handleOAuthUrl = async (url: string) => {
      const route = oauthCallbackRouteFromUrl(url);
      if (!route) return;

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

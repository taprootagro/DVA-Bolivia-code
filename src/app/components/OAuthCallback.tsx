import { useEffect, useState, startTransition } from "react";
import { useNavigate } from "react-router";
import type { Session } from "@supabase/supabase-js";
import { Loader2, AlertTriangle, CheckCircle } from "lucide-react";
import { setUserLoggedIn, setServerUserId, setAccessToken } from "../utils/auth";
import { useLanguage } from "../hooks/useLanguage";
import { isNative } from "../utils/capacitor-bridge";
import {
  applyOAuthMetadataToLocalProfile,
  exchangeRegionalOAuthCode,
  getSupabaseBrowserClient,
  syncUserProfileFromServer,
} from "../utils/supabaseBrowser";

// ============================================================================
// OAuthCallback — Supabase Auth PKCE（signInWithOAuth 回到 /auth/callback）
// ============================================================================

type Status = "exchanging" | "success" | "error" | "retrying";

/** PKCE 失败常见于 PWA standalone vs 系统浏览器存储隔离 — 对用户展示可读说明 */
function formatPkceFriendlyError(raw: string, oauthPkceVerifierHint?: string): string {
  const s = (raw || "").trim();
  const hint = (oauthPkceVerifierHint || "").trim();
  if (!hint || !/(PKCE|code verifier)/i.test(s)) return s;
  return `${hint}\n\n— — —\n${s}`;
}

export function OAuthCallback() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [status, setStatus] = useState<Status>("exchanging");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function finalizeSession(session: Session) {
      if (!session.access_token || !session.user?.id) return false;
      setAccessToken(session.access_token);
      setServerUserId(session.user.id);
      await syncUserProfileFromServer(session.access_token);
      applyOAuthMetadataToLocalProfile(session.user);
      if (window.history.replaceState) {
        window.history.replaceState({}, document.title, "/auth/callback");
      }
      if (!cancelled) {
        setUserLoggedIn(true);
        setStatus("success");

        // Detect whether the callback is running inside the PWA standalone
        // window or in the system browser.  On iOS, the OAuth redirect lands
        // in Safari (system browser), not the PWA — navigating to
        // /home/profile in Safari would leave the user stranded there.
        // Instead we redirect to the origin so the user can return to the
        // PWA from the home screen; the PWA will detect the session via
        // the cookie fallback on foreground.
        const isStandalone = typeof window !== "undefined" && window.matchMedia("(display-mode: standalone)").matches;

        if (isNative() || isStandalone) {
          setTimeout(() => {
            navigate("/home/profile", { replace: true });
          }, 600);
        } else {
          setTimeout(() => {
            window.location.href = window.location.origin;
          }, 1500);
        }
      }
      return true;
    }

    async function run() {
      const params = new URLSearchParams(window.location.search);
      const hashParams = new URLSearchParams(window.location.hash.slice(1));
      const oauthError = params.get("error") || hashParams.get("error");
      if (oauthError) {
        setStatus("error");
        setErrorMsg(
          params.get("error_description") || hashParams.get("error_description") || oauthError,
        );
        return;
      }

      const client = getSupabaseBrowserClient();
      if (!client) {
        setStatus("error");
        setErrorMsg(t.login.supabaseAuthMissing ?? t.login.oauthNotConfigured);
        return;
      }

      const { data: existing } = await client.auth.getSession();
      if (existing.session?.user && existing.session.access_token) {
        await finalizeSession(existing.session);
        return;
      }

      const hasCode = !!(params.get("code") || hashParams.get("code"));
      const oauthState = params.get("state") || hashParams.get("state");

      // Regional OAuth: WeChat / Alipay / LINE — exchange via Edge Function, not supabase PKCE
      if (hasCode && oauthState && ['wechat', 'alipay', 'line'].includes(oauthState)) {
        const code = (params.get("code") || hashParams.get("code") || '').trim();
        if (!code) {
          setStatus("error");
          setErrorMsg(t.login.oauthError);
          return;
        }
        try {
          const platform = oauthState as 'wechat' | 'alipay' | 'line';
          const redirectUri = platform === 'line' ? `${window.location.origin}/auth/callback` : undefined;
          const result = await exchangeRegionalOAuthCode(platform, code, redirectUri);
          setAccessToken(result.accessToken);
          setServerUserId(result.userId);
          if (!cancelled) {
            setUserLoggedIn(true);
            setStatus("success");
            setTimeout(() => {
              navigate("/home/profile", { replace: true });
            }, 600);
          }
          return;
        } catch (err: any) {
          if (!cancelled) {
            setStatus("error");
            setErrorMsg(err?.message || t.login.oauthError);
          }
          return;
        }
      }

      if (hasCode) {
        const ex = await client.auth.exchangeCodeForSession(window.location.href);
        if (ex.error) {
          const retry = await client.auth.getSession();
          if (retry.data.session?.user && retry.data.session.access_token) {
            await finalizeSession(retry.data.session);
            return;
          }
          if (!cancelled) {
            const isPkce =
              /(PKCE|code verifier)/i.test(ex.error.message || "");
            if (isPkce) {
              // PKCE verifier missing — most likely the user switched browsers
              // (PWA standalone → system browser) or re-logged in a different
              // context.  Auto-redirect to /login so a fresh OAuth flow with a
              // new verifier can start in the current browser's storage.
              setStatus("retrying");
              setTimeout(() => {
                navigate("/login", { replace: true });
              }, 2500);
            } else {
              setStatus("error");
              setErrorMsg(
                formatPkceFriendlyError(ex.error.message, t.login.oauthPkceVerifierHint),
              );
            }
          }
          return;
        }
        if (ex.data.session) {
          await finalizeSession(ex.data.session);
          return;
        }
      }

      const { data: after } = await client.auth.getSession();
      if (after.session?.user && after.session.access_token) {
        await finalizeSession(after.session);
        return;
      }

      if (!cancelled) {
        setStatus("error");
        setErrorMsg(t.login.oauthError);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot OAuth return; avoid re-running on t reference changes
  }, [navigate]);

  return (
    <div className="fixed inset-0 bg-white flex items-center justify-center px-8">
      <div className="text-center max-w-xs">
        {status === "exchanging" && (
          <>
            <Loader2 className="w-12 h-12 text-emerald-600 animate-spin mx-auto mb-4" />
            <p className="text-gray-700 font-medium">{t.login.redirecting}</p>
            <p className="text-xs text-gray-400 mt-2">Verifying your identity...</p>
          </>
        )}

        {status === "success" && (
          <>
            <CheckCircle className="w-12 h-12 text-emerald-600 mx-auto mb-4" />
            <p className="text-gray-700 font-medium">{t.login.redirecting}</p>
          </>
        )}

        {status === "retrying" && (
          <>
            <Loader2 className="w-12 h-12 text-emerald-600 animate-spin mx-auto mb-4" />
            <p className="text-gray-700 font-medium">{t.login.oauthError}</p>
            <p className="text-xs text-amber-600 mt-2">
              {t.login.oauthPkceVerifierHint}
            </p>
          </>
        )}

        {status === "error" && (
          <>
            <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <p className="text-gray-700 font-medium">{t.login.oauthError}</p>
            <p className="text-xs text-red-400 mt-2 break-words whitespace-pre-wrap text-start max-h-[45vh] overflow-y-auto">
              {errorMsg}
            </p>
            <button
              onClick={() => startTransition(() => { void navigate("/login", { replace: true }); })}
              className="mt-6 bg-emerald-600 text-white px-6 py-2.5 rounded-xl active:bg-emerald-700 transition-colors font-medium text-sm"
            >
              {t.login.loginButton}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default OAuthCallback;

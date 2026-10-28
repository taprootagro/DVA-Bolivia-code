import type { HomePageConfig } from "../../hooks/useHomeConfig";
import { ensureEdgeSessionReady } from "../../utils/auth";

/** `server` Edge base + anon key + fresh session token for CMS admin calls; null when the connection isn't configured. */
export async function edgeFnAuth(
  cfg: HomePageConfig,
): Promise<{ base: string; anon: string; token: string } | null> {
  const bp = cfg?.backendProxyConfig;
  const url = (bp?.supabaseUrl || "").trim().replace(/\/$/, "");
  const anon = (bp?.supabaseAnonKey || "").trim();
  const fn = (bp?.edgeFunctionName || "server").trim() || "server";
  if (!url || !anon) return null;
  const base = `${url}/functions/v1/${fn}`;
  const token = (await ensureEdgeSessionReady()) ?? "";
  return { base, anon, token };
}

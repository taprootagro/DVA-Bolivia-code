/**
 * 聊天 Tab：跨次进入保留「农户 / 门店」身份分支；门店端保留最近打开的 1v1 线程。
 * 登出时由 clearAuthData 清理 role 缓存；门店线程状态用 sessionStorage（标签关闭即弃）。
 */

const ROLE_KEY = "taproot_community_role_cache_v1";
const STORE_SHELL_KEY = "taproot_store_shell_state_v1";

type RolePayload = { userId: string; mode: "farmer" | "distributor" };

export type StoreShellPersisted = {
  storeUserId: string;
  shell: "recents" | "contacts" | "thread";
  peerKey: string | null;
};

export function readCommunityRoleCache(
  userId: string | null,
): "farmer" | "distributor" | null {
  if (!userId || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(ROLE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as RolePayload;
    if (p.userId !== userId) return null;
    if (p.mode !== "farmer" && p.mode !== "distributor") return null;
    return p.mode;
  } catch {
    return null;
  }
}

export function writeCommunityRoleCache(
  userId: string,
  mode: "farmer" | "distributor",
): void {
  try {
    localStorage.setItem(ROLE_KEY, JSON.stringify({ userId, mode }));
  } catch {
    /* quota / private mode */
  }
}

export function clearCommunityRoleCache(): void {
  try {
    localStorage.removeItem(ROLE_KEY);
  } catch {
    /* ignore */
  }
}

export function readStoreShellState(storeUserId: string): StoreShellPersisted | null {
  if (!storeUserId || typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORE_SHELL_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as StoreShellPersisted;
    if (o.storeUserId !== storeUserId) return null;
    if (o.shell !== "recents" && o.shell !== "contacts" && o.shell !== "thread") return null;
    return {
      storeUserId: o.storeUserId,
      shell: o.shell,
      peerKey: typeof o.peerKey === "string" ? o.peerKey : null,
    };
  } catch {
    return null;
  }
}

export function writeStoreShellState(state: StoreShellPersisted): void {
  try {
    sessionStorage.setItem(STORE_SHELL_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

export function clearStoreShellState(): void {
  try {
    sessionStorage.removeItem(STORE_SHELL_KEY);
  } catch {
    /* ignore */
  }
}

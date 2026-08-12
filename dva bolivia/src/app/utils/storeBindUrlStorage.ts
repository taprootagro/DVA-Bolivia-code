import { storageGet, storageSet } from "./safeStorage";

const PREFIX = "taproot-store-bind-url";

export function storeBindUrlStorageKey(userId: string): string {
  return `${PREFIX}:${userId}`;
}

export function getStoredStoreBindUrl(userId: string): string | null {
  return storageGet(storeBindUrlStorageKey(userId));
}

export function setStoredStoreBindUrl(userId: string, url: string): boolean {
  return storageSet(storeBindUrlStorageKey(userId), url);
}

/** Parse /m/{token} from a full HTTPS bind URL (e.g. from merchant-bind-pool). */
export function extractBindTokenFromFullUrl(fullUrl: string): string | null {
  try {
    const u = new URL(fullUrl);
    const m = u.pathname.match(/^\/m\/([A-Za-z0-9_-]{6,256})\/?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

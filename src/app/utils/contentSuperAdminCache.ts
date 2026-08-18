import { CONTENT_SUPER_ADMIN_CACHE_KEY } from "../constants";
import { storageGetJSON, storageRemove, storageSetJSON } from "./safeStorage";

export type ContentSuperAdminCachePayload = {
  userId: string;
  verifiedAt: number;
  contentRole?: string;
};

/** CMS content-role cache TTL — stale entries must not grant CMS UI. */
export const CONTENT_SUPER_ADMIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function readContentSuperAdminCache(): ContentSuperAdminCachePayload | null {
  const cached = storageGetJSON<ContentSuperAdminCachePayload>(
    CONTENT_SUPER_ADMIN_CACHE_KEY,
    null,
  );
  if (!cached) return null;
  if (
    typeof cached.verifiedAt === "number" &&
    Date.now() - cached.verifiedAt > CONTENT_SUPER_ADMIN_CACHE_TTL_MS
  ) {
    clearContentSuperAdminCache();
    return null;
  }
  return cached;
}

export function writeContentSuperAdminCache(userId: string, contentRole?: string): void {
  storageSetJSON(CONTENT_SUPER_ADMIN_CACHE_KEY, {
    userId,
    verifiedAt: Date.now(),
    contentRole,
  });
}

export function clearContentSuperAdminCache(): void {
  storageRemove(CONTENT_SUPER_ADMIN_CACHE_KEY);
}

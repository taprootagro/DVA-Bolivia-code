import { storageGetJSON, storageSetJSON, storageRemove } from "./safeStorage";

const KEY = "__taproot_linked_google__";

interface Payload {
  google: string;
}

/** 编辑资料页「快捷登录账号」长期缓存：仅 Google 邮箱，避免每次打开都 getUser。 */
export function getLinkedGoogleCache(): string | null {
  const o = storageGetJSON<Payload>(KEY);
  const g = o?.google;
  return typeof g === "string" && g.trim() ? g.trim() : null;
}

export function setLinkedGoogleCache(google: string): void {
  const v = google.trim();
  if (!v) return;
  storageSetJSON(KEY, { google: v });
}

export function clearLinkedGoogleCache(): void {
  storageRemove(KEY);
}

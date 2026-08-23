import type { ChatMessage } from "./ChatProxyService";
import type { StorePeerRecord, StoreRecentRecord } from "./storeChatDirectory";
import { fetchAndCacheMedia } from "./chatLocalStore";

const THREAD_CACHE_MAX = 20;
const AVATAR_PREFETCH_MAX = 40;

const threadByChannel = new Map<string, ChatMessage[]>();
const objectUrlByRemote = new Map<string, string>();
const retainedObjectUrls = new Set<string>();

export type StoreListSnap = {
  recentsRows: { recent: StoreRecentRecord; peer?: StorePeerRecord }[];
  peers: StorePeerRecord[];
  blocked: string[];
};

const storeListByUser = new Map<string, StoreListSnap>();

export function recallThread(channelId: string): ChatMessage[] | null {
  if (!channelId) return null;
  const cached = threadByChannel.get(channelId);
  return cached ? cached.slice() : null;
}

export function rememberThread(channelId: string, msgs: ChatMessage[]): void {
  if (!channelId) return;
  threadByChannel.delete(channelId);
  threadByChannel.set(channelId, msgs.slice());
  while (threadByChannel.size > THREAD_CACHE_MAX) {
    const oldest = threadByChannel.keys().next().value;
    if (!oldest) break;
    threadByChannel.delete(oldest);
  }
}

export function recallStoreLists(storeUserId: string): StoreListSnap | null {
  if (!storeUserId) return null;
  const snap = storeListByUser.get(storeUserId);
  return snap
    ? {
        recentsRows: snap.recentsRows.slice(),
        peers: snap.peers.slice(),
        blocked: snap.blocked.slice(),
      }
    : null;
}

export function rememberStoreLists(storeUserId: string, snap: StoreListSnap): void {
  if (!storeUserId) return;
  storeListByUser.set(storeUserId, {
    recentsRows: snap.recentsRows.slice(),
    peers: snap.peers.slice(),
    blocked: snap.blocked.slice(),
  });
}

export function peekCachedObjectUrl(remoteUrl: string): string | undefined {
  return objectUrlByRemote.get(remoteUrl);
}

export function retainObjectUrl(url: string | undefined): void {
  if (!url || !url.startsWith("blob:")) return;
  retainedObjectUrls.add(url);
}

export function rememberObjectUrl(remoteUrl: string, blob: Blob): string {
  const existing = objectUrlByRemote.get(remoteUrl);
  if (existing) return existing;
  const obj = URL.createObjectURL(blob);
  objectUrlByRemote.set(remoteUrl, obj);
  retainedObjectUrls.add(obj);
  return obj;
}

export async function resolveCachedMediaUrl(remoteUrl: string): Promise<string> {
  const url = (remoteUrl || "").trim();
  if (!url || url.startsWith("blob:") || url.startsWith("data:")) return url;
  const peeked = objectUrlByRemote.get(url);
  if (peeked) return peeked;
  const blob = await fetchAndCacheMedia(url);
  if (!blob) return url;
  return rememberObjectUrl(url, blob);
}

export function prefetchMediaUrls(urls: Array<string | undefined | null>): void {
  const seen = new Set<string>();
  let n = 0;
  for (const raw of urls) {
    const url = (raw || "").trim();
    if (!url || url.startsWith("blob:") || url.startsWith("data:")) continue;
    if (seen.has(url) || objectUrlByRemote.has(url)) continue;
    seen.add(url);
    n += 1;
    if (n > AVATAR_PREFETCH_MAX) break;
    void resolveCachedMediaUrl(url);
  }
}

export function clearChatUiMemory(): void {
  threadByChannel.clear();
  storeListByUser.clear();
  objectUrlByRemote.clear();
  for (const u of retainedObjectUrls) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* ignore */
    }
  }
  retainedObjectUrls.clear();
}

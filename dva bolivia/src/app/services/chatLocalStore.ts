// ============================================================================
// chatLocalStore.ts
// ============================================================================
// 目标：把"聊天消息 + 媒体 blob"长期留在手机本地（IndexedDB），
//       云端（Supabase）只当短期临时桶（默认 3 天，见 CHAT_RETENTION_DAYS / pg_cron），过期自动清理。
//       服务端 purge 后客户端仍可通过本地缓存展示历史与已缓存媒体；since 增量补拉窗口与保留天数对齐。
//
// 对外 API：
//   - cacheMessages(msgs)                 // 送达/收到即写入
//   - getRecent(channelName, limit=30)    // 进入线程时的首屏 （DESC 取最新）
//   - getOlder(channelName, beforeTs, limit=30)   // 向上翻页
//   - getLatestTimestamp(channelName)     // 本地最新一条的时间戳，用于向服务端 since 增量
//   - purgeChannel(channelName)           // 删除某会话全部消息（不动媒体，媒体按 LRU 自然淘汰）
//   - putMedia(url, blob, mime)           // 下载完成后写入缓存
//   - fetchAndCacheMedia(url)             // 未缓存则抓一次，返回 blob
//   - getMediaBlob(url)                   // 只读，命中才返回
//   - touchMedia(url)                     // 命中时刷新 addedAt → 起到 LRU 作用
//   - pruneMediaToBytes(maxBytes=80MB)    // 启动时按 addedAt 修剪
//   - MEDIA_CACHE_MAX_BYTES
// ============================================================================

import type { ChatMessage } from "./ChatProxyService";
import { getTaprootAgroIDB } from "../utils/db";

const STORE_MSG = "chatMessages";
const STORE_MEDIA = "chatMedia";

export const MEDIA_CACHE_MAX_BYTES = 80 * 1024 * 1024; // 80 MB 硬顶
const IDX_BY_CHANNEL = "byChannel";
const IDX_BY_CHANNEL_ONLY = "byChannelOnly";
const IDX_BY_ADDED_AT = "byAddedAt";

interface StoredMediaRecord {
  url: string;          // 远端 URL（keyPath）
  blob: Blob;
  mime: string;
  size: number;
  addedAt: number;      // 命中即刷新，作为 LRU
}

// ---- low-level helpers --------------------------------------------------

async function withMsgStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T
): Promise<T> {
  const db = await getTaprootAgroIDB();
  const { store, done } = db.tx(STORE_MSG, mode);
  const result = await fn(store);
  await done;
  return result;
}

async function withMediaStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T
): Promise<T> {
  const db = await getTaprootAgroIDB();
  const { store, done } = db.tx(STORE_MEDIA, mode);
  const result = await fn(store);
  await done;
  return result;
}

function promisifyReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- Messages -----------------------------------------------------------

export async function cacheMessages(msgs: ChatMessage[]): Promise<void> {
  if (!msgs?.length) return;
  try {
    await withMsgStore("readwrite", (store) => {
      for (const m of msgs) {
        if (!m?.id || !m?.channelName) continue;
        // 仅缓存已落地的消息（避免把失败草稿写入，失败状态已经在内存中处理）
        if (m.status === "failed") continue;
        try { store.put(m); } catch { /* ignore single put failure */ }
      }
    });
  } catch (err) {
    console.warn("[chatLocalStore] cacheMessages failed:", err);
  }
}

/** 取某会话最近 N 条（按 timestamp 升序返回，便于直接渲染） */
export async function getRecent(
  channelName: string,
  limit = 30
): Promise<ChatMessage[]> {
  if (!channelName) return [];
  try {
    return await withMsgStore("readonly", async (store) => {
      const idx = store.index(IDX_BY_CHANNEL);
      const range = IDBKeyRange.bound(
        [channelName, -Infinity],
        [channelName, Infinity]
      );
      const out: ChatMessage[] = [];
      // 反向游标，拿最新的 limit 条，然后再反转
      await new Promise<void>((resolve, reject) => {
        const req = idx.openCursor(range, "prev");
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur || out.length >= limit) return resolve();
          out.push(cur.value as ChatMessage);
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
      return out.reverse();
    });
  } catch (err) {
    console.warn("[chatLocalStore] getRecent failed:", err);
    return [];
  }
}

/** 取某会话 < beforeTs 的前 N 条（按 timestamp 升序返回） */
export async function getOlder(
  channelName: string,
  beforeTs: number,
  limit = 30
): Promise<ChatMessage[]> {
  if (!channelName) return [];
  try {
    return await withMsgStore("readonly", async (store) => {
      const idx = store.index(IDX_BY_CHANNEL);
      const range = IDBKeyRange.bound(
        [channelName, -Infinity],
        [channelName, beforeTs - 1]
      );
      const out: ChatMessage[] = [];
      await new Promise<void>((resolve, reject) => {
        const req = idx.openCursor(range, "prev");
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur || out.length >= limit) return resolve();
          out.push(cur.value as ChatMessage);
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
      return out.reverse();
    });
  } catch (err) {
    console.warn("[chatLocalStore] getOlder failed:", err);
    return [];
  }
}

/** 本地最新一条的时间戳；没有返回 0 */
export async function getLatestTimestamp(channelName: string): Promise<number> {
  if (!channelName) return 0;
  try {
    return await withMsgStore("readonly", async (store) => {
      const idx = store.index(IDX_BY_CHANNEL);
      const range = IDBKeyRange.bound(
        [channelName, -Infinity],
        [channelName, Infinity]
      );
      return await new Promise<number>((resolve, reject) => {
        const req = idx.openCursor(range, "prev");
        req.onsuccess = () => {
          const cur = req.result;
          resolve(cur ? (cur.value as ChatMessage).timestamp || 0 : 0);
        };
        req.onerror = () => reject(req.error);
      });
    });
  } catch {
    return 0;
  }
}

export async function purgeChannel(channelName: string): Promise<void> {
  if (!channelName) return;
  try {
    await withMsgStore("readwrite", async (store) => {
      const idx = store.index(IDX_BY_CHANNEL_ONLY);
      await new Promise<void>((resolve, reject) => {
        const req = idx.openCursor(IDBKeyRange.only(channelName));
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve();
          try { cur.delete(); } catch { /* ignore */ }
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });
  } catch (err) {
    console.warn("[chatLocalStore] purgeChannel failed:", err);
  }
}

/** 删号 / 退出时清空本机全部聊天消息与媒体缓存 */
export async function purgeAllChatLocalData(): Promise<void> {
  try {
    await withMsgStore("readwrite", async (store) => {
      await new Promise<void>((resolve, reject) => {
        const req = store.openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve();
          try {
            cur.delete();
          } catch {
            /* ignore */
          }
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });
    await withMediaStore("readwrite", async (store) => {
      await new Promise<void>((resolve, reject) => {
        const req = store.openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve();
          try {
            cur.delete();
          } catch {
            /* ignore */
          }
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });
    _lastKnownTotalBytes = 0;
  } catch (err) {
    console.warn("[chatLocalStore] purgeAllChatLocalData failed:", err);
  }
}

// ---- Media blobs --------------------------------------------------------

export async function putMedia(
  url: string,
  blob: Blob,
  mime?: string
): Promise<void> {
  if (!url || !blob) return;
  const rec: StoredMediaRecord = {
    url,
    blob,
    mime: mime || blob.type || "application/octet-stream",
    size: blob.size || 0,
    addedAt: Date.now(),
  };
  try {
    await withMediaStore("readwrite", (store) => {
      store.put(rec);
    });
    // 轻量 prune：只在超过上限时才全扫，绝大多数调用会在首层 size 检查后直接返回
    void softPruneMedia();
  } catch (err) {
    console.warn("[chatLocalStore] putMedia failed:", err);
  }
}

export async function getMediaBlob(url: string): Promise<Blob | null> {
  if (!url) return null;
  try {
    const rec = await withMediaStore("readonly", async (store) => {
      return await promisifyReq(store.get(url)) as StoredMediaRecord | undefined;
    });
    if (!rec?.blob) return null;
    // 命中即刷新 LRU（不阻塞返回）
    void touchMedia(url);
    return rec.blob;
  } catch (err) {
    console.warn("[chatLocalStore] getMediaBlob failed:", err);
    return null;
  }
}

export async function touchMedia(url: string): Promise<void> {
  if (!url) return;
  try {
    await withMediaStore("readwrite", async (store) => {
      const rec = await promisifyReq(store.get(url)) as StoredMediaRecord | undefined;
      if (!rec) return;
      rec.addedAt = Date.now();
      store.put(rec);
    });
  } catch { /* ignore */ }
}

/** url 未缓存则 fetch 一次，写入缓存并返回 blob；已缓存直接返回 */
export async function fetchAndCacheMedia(
  url: string,
  signal?: AbortSignal
): Promise<Blob | null> {
  if (!url || typeof url !== "string") return null;
  // blob:/data: 已是本地，不需缓存
  if (url.startsWith("blob:") || url.startsWith("data:")) return null;
  const cached = await getMediaBlob(url);
  if (cached) return cached;
  try {
    const r = await fetch(url, { signal, credentials: "omit" });
    if (!r.ok) return null;
    const blob = await r.blob();
    // 过大的单个文件（> 20MB）跳过缓存，避免单条把整个配额吃光
    if (blob.size > 20 * 1024 * 1024) return blob;
    await putMedia(url, blob, blob.type);
    return blob;
  } catch {
    return null;
  }
}

// ---- LRU prune ----------------------------------------------------------

let _pruneInflight: Promise<void> | null = null;
let _lastKnownTotalBytes = 0;

/** 启动时 / 每次 putMedia 后调用；超过 max 才真扫 */
export function softPruneMedia(maxBytes: number = MEDIA_CACHE_MAX_BYTES): Promise<void> {
  if (_pruneInflight) return _pruneInflight;
  if (_lastKnownTotalBytes > 0 && _lastKnownTotalBytes < maxBytes * 0.9) {
    // 粗估没超限就跳过，避免每次 put 都全扫
    return Promise.resolve();
  }
  _pruneInflight = pruneMediaToBytes(maxBytes).finally(() => { _pruneInflight = null; });
  return _pruneInflight;
}

/** 真实的 prune：按 addedAt 从旧到新扫，直到总和 ≤ maxBytes */
export async function pruneMediaToBytes(maxBytes: number = MEDIA_CACHE_MAX_BYTES): Promise<void> {
  try {
    // 先统计
    const total = await withMediaStore("readonly", async (store) => {
      let sum = 0;
      await new Promise<void>((resolve, reject) => {
        const req = store.openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve();
          const rec = cur.value as StoredMediaRecord;
          sum += rec?.size || 0;
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
      return sum;
    });
    _lastKnownTotalBytes = total;
    if (total <= maxBytes) return;

    let toFree = total - maxBytes;
    await withMediaStore("readwrite", async (store) => {
      const idx = store.index(IDX_BY_ADDED_AT);
      await new Promise<void>((resolve, reject) => {
        const req = idx.openCursor(null, "next"); // 从最旧开始
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur || toFree <= 0) return resolve();
          const rec = cur.value as StoredMediaRecord;
          try { cur.delete(); } catch { /* ignore */ }
          toFree -= rec?.size || 0;
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });
    // 修剪后重新采样
    _lastKnownTotalBytes = Math.max(0, total - (total - maxBytes));
  } catch (err) {
    console.warn("[chatLocalStore] pruneMediaToBytes failed:", err);
  }
}

/**
 * 门店模式：本地通讯录 / 最近会话 / 屏蔽 / 删除标记（IndexedDB，按门店登录用户隔离）
 */
import { getTaprootAgroIDB } from "../utils/db";
import { isDeletedSenderId, isUserAnonymizedAsDeleted } from "../utils/accountDeletion";

export interface StorePeerRecord {
  id: string;
  storeUserId: string;
  peerKey: string;
  name: string;
  avatar: string;
  subtitle: string;
  imUserId: string;
  channelId: string;
  imProvider: string;
  phone: string;
  storeId: string;
  /** 用于 A–Z 分组，大写首字符或 # */
  sortLetter: string;
  updatedAt: number;
}

export interface StoreRecentRecord {
  id: string;
  storeUserId: string;
  peerKey: string;
  lastMessageAt: number;
  lastPreview: string;
  unread: number;
}

export interface StoreBlockedRecord {
  id: string;
  storeUserId: string;
  peerKey: string;
  blockedAt: number;
}

export interface StoreDeletedRecord {
  id: string;
  storeUserId: string;
  peerKey: string;
  deletedAt: number;
}

function compoundId(storeUserId: string, peerKey: string): string {
  return `${storeUserId}::${peerKey}`;
}

/** 稳定会话键：优先 channelId */
export function makePeerKey(channelId: string, imUserId: string): string {
  const ch = (channelId || "").trim();
  if (ch && ch !== "your-channel-id") return `ch:${ch}`;
  return `uid:${(imUserId || "").trim() || "unknown"}`;
}

function sortLetterFromName(name: string): string {
  const t = (name || "").trim();
  if (!t) return "#";
  const c = t.charAt(0).toUpperCase();
  if (/[A-Z]/.test(c)) return c;
  if (/[0-9]/.test(c)) return "#";
  return "#";
}

/** UUID 前缀等占位名，不应作为门店侧展示名 */
export function isWeakPeerName(name: string, imUserId: string): boolean {
  const n = (name || "").trim();
  if (!n) return true;
  const uid = (imUserId || "").trim();
  if (!uid) return false;
  if (n === uid) return true;
  if (n.length === 8 && uid.toLowerCase().startsWith(n.toLowerCase()) && /^[0-9a-f]{8}$/i.test(n)) {
    return true;
  }
  return false;
}

export function peerDisplayName(
  peer: Pick<StorePeerRecord, "name" | "imUserId">,
  fallback = "Farmer",
  options?: { deletedLabel?: string; lastSenderId?: string },
): string {
  const deletedLabel = options?.deletedLabel?.trim();
  const lastSenderId = options?.lastSenderId?.trim();
  if (
    deletedLabel &&
    lastSenderId &&
    isUserAnonymizedAsDeleted(peer.imUserId, lastSenderId)
  ) {
    return deletedLabel;
  }
  if (deletedLabel && isDeletedSenderId(peer.imUserId)) {
    return deletedLabel;
  }
  const n = (peer.name || "").trim();
  if (n && !isWeakPeerName(n, peer.imUserId)) return n;
  return fallback;
}

function resolvePeerDisplayName(
  incomingName: string,
  existingName: string | undefined,
  imUserId: string,
): string {
  const incoming = incomingName.trim();
  const existing = (existingName || "").trim();
  if (incoming && (!existing || isWeakPeerName(existing, imUserId))) return incoming;
  if (existing && !isWeakPeerName(existing, imUserId)) return existing;
  return incoming || existing;
}

export function peerToContactFields(p: StorePeerRecord): {
  name: string;
  avatar: string;
  subtitle: string;
  imUserId: string;
  channelId: string;
  imProvider: string;
  phone: string;
  storeId: string;
} {
  return {
    name: p.name,
    avatar: p.avatar,
    subtitle: p.subtitle,
    imUserId: p.imUserId,
    channelId: p.channelId,
    imProvider: p.imProvider,
    phone: p.phone,
    storeId: p.storeId,
  };
}

async function getDb() {
  return getTaprootAgroIDB();
}

/** 单门店账号本地通讯录最大行数（storePeers） */
export const MAX_STORE_PEERS = 1000;
export const STORE_PEER_LIMIT_CODE = "STORE_PEER_LIMIT";

export async function countPeersForStore(storeUserId: string): Promise<number> {
  const db = await getDb();
  const all = await db.getAll<StorePeerRecord>("storePeers");
  return all.filter((r) => r.storeUserId === storeUserId).length;
}

export async function upsertPeer(
  storeUserId: string,
  partial: {
    peerKey: string;
    name: string;
    avatar?: string;
    subtitle?: string;
    imUserId: string;
    channelId: string;
    imProvider?: string;
    phone?: string;
    storeId?: string;
  },
): Promise<StorePeerRecord> {
  const db = await getDb();
  const id = compoundId(storeUserId, partial.peerKey);
  const existing = await db.get<StorePeerRecord>("storePeers", id);
  if (!existing) {
    const n = await countPeersForStore(storeUserId);
    if (n >= MAX_STORE_PEERS) {
      const err = new Error("Store peer limit reached");
      (err as Error & { code?: string }).code = STORE_PEER_LIMIT_CODE;
      throw err;
    }
  }
  const name = resolvePeerDisplayName(partial.name, existing?.name, partial.imUserId);
  const incomingAvatar = (partial.avatar ?? "").trim();
  const existingAvatar = (existing?.avatar ?? "").trim();
  const avatar = incomingAvatar || existingAvatar;
  const row: StorePeerRecord = {
    id,
    storeUserId,
    peerKey: partial.peerKey,
    name,
    avatar,
    subtitle: partial.subtitle ?? existing?.subtitle ?? "",
    imUserId: partial.imUserId,
    channelId: partial.channelId,
    imProvider: partial.imProvider ?? existing?.imProvider ?? "tencent-im",
    phone: partial.phone ?? existing?.phone ?? "",
    storeId: partial.storeId ?? existing?.storeId ?? "",
    sortLetter: sortLetterFromName(name),
    updatedAt: Date.now(),
  };
  await db.put("storePeers", row);
  return row;
}

/** Upsert peer row then update recent line（会话自然流入 / 发消息时调用） */
export async function touchRecentWithPeerEnsure(
  storeUserId: string,
  peer: Pick<
    StorePeerRecord,
    "peerKey" | "channelId" | "imUserId" | "name" | "avatar" | "subtitle" | "imProvider" | "phone" | "storeId"
  >,
  preview: string,
  bumpUnreadForIncoming = false,
): Promise<void> {
  if (await isBlocked(storeUserId, peer.peerKey)) return;

  await upsertPeer(storeUserId, {
    peerKey: peer.peerKey,
    name: peer.name,
    avatar: peer.avatar,
    subtitle: peer.subtitle,
    imUserId: peer.imUserId,
    channelId: peer.channelId,
    imProvider: peer.imProvider,
    phone: peer.phone,
    storeId: peer.storeId,
  });
  await touchRecent(storeUserId, peer.peerKey, preview, bumpUnreadForIncoming);
}

export async function touchRecent(
  storeUserId: string,
  peerKey: string,
  preview: string,
  bumpUnreadForIncoming = false,
): Promise<void> {
  const db = await getDb();
  const id = compoundId(storeUserId, peerKey);
  const existing = await db.get<StoreRecentRecord>("storeRecents", id);
  const unread = bumpUnreadForIncoming ? (existing?.unread ?? 0) + 1 : existing?.unread ?? 0;
  const row: StoreRecentRecord = {
    id,
    storeUserId,
    peerKey,
    lastMessageAt: Date.now(),
    lastPreview: preview.slice(0, 200),
    unread,
  };
  await db.put("storeRecents", row);
  await db.delete("storeDeletedThreads", id);
}

export async function clearUnread(storeUserId: string, peerKey: string): Promise<void> {
  const db = await getDb();
  const id = compoundId(storeUserId, peerKey);
  const existing = await db.get<StoreRecentRecord>("storeRecents", id);
  if (!existing) return;
  await db.put("storeRecents", { ...existing, unread: 0 });
}

export async function listPeersSorted(storeUserId: string): Promise<StorePeerRecord[]> {
  const db = await getDb();
  const all = await db.getAll<StorePeerRecord>("storePeers");
  const mine = all.filter((r) => r.storeUserId === storeUserId);
  return mine
    .sort((a, b) => {
      const la = (a.name || "").localeCompare(b.name || "", "zh-Hans-CN", { sensitivity: "base" });
      if (la !== 0) return la;
      return a.peerKey.localeCompare(b.peerKey);
    });
}

export async function listRecents(storeUserId: string): Promise<StoreRecentRecord[]> {
  const db = await getDb();
  const all = await db.getAll<StoreRecentRecord>("storeRecents");
  const deleted = new Set(await listDeletedPeerKeys(storeUserId));
  return all
    .filter((r) => r.storeUserId === storeUserId && !deleted.has(r.peerKey))
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

export async function getPeer(storeUserId: string, peerKey: string): Promise<StorePeerRecord | undefined> {
  const db = await getDb();
  return db.get<StorePeerRecord>("storePeers", compoundId(storeUserId, peerKey));
}

export async function listBlockedPeerKeys(storeUserId: string): Promise<string[]> {
  const db = await getDb();
  const all = await db.getAll<StoreBlockedRecord>("storeBlocked");
  return all.filter((r) => r.storeUserId === storeUserId).map((r) => r.peerKey);
}

async function listDeletedPeerKeys(storeUserId: string): Promise<string[]> {
  const db = await getDb();
  const all = await db.getAll<StoreDeletedRecord>("storeDeletedThreads");
  return all.filter((r) => r.storeUserId === storeUserId).map((r) => r.peerKey);
}

export async function isBlocked(storeUserId: string, peerKey: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.get<StoreBlockedRecord>("storeBlocked", compoundId(storeUserId, peerKey));
  return !!row;
}

export async function blockPeer(storeUserId: string, peerKey: string): Promise<void> {
  const db = await getDb();
  const id = compoundId(storeUserId, peerKey);
  await db.put("storeBlocked", {
    id,
    storeUserId,
    peerKey,
    blockedAt: Date.now(),
  } satisfies StoreBlockedRecord);
  const rec = await db.get<StoreRecentRecord>("storeRecents", id);
  if (rec) {
    await db.put("storeRecents", { ...rec, unread: 0 });
  }
}

export async function unblockPeer(storeUserId: string, peerKey: string): Promise<void> {
  const db = await getDb();
  await db.delete("storeBlocked", compoundId(storeUserId, peerKey));
}

/** 最近列表长按删除：移除最近 + 标记删除（直到有新消息） */
export async function deleteRecentThread(storeUserId: string, peerKey: string): Promise<void> {
  const db = await getDb();
  const id = compoundId(storeUserId, peerKey);
  await db.delete("storeRecents", id);
  await db.put("storeDeletedThreads", {
    id,
    storeUserId,
    peerKey,
    deletedAt: Date.now(),
  } satisfies StoreDeletedRecord);
}

export async function removePeerAndData(storeUserId: string, peerKey: string): Promise<void> {
  const db = await getDb();
  const id = compoundId(storeUserId, peerKey);
  await db.delete("storePeers", id);
  await db.delete("storeRecents", id);
  await db.delete("storeBlocked", id);
  await db.delete("storeDeletedThreads", id);
}

/** 按字母分组（通讯录） */
export function groupPeersByLetter(peers: StorePeerRecord[]): { letter: string; peers: StorePeerRecord[] }[] {
  const map = new Map<string, StorePeerRecord[]>();
  for (const p of peers) {
    const L = p.sortLetter || "#";
    if (!map.has(L)) map.set(L, []);
    map.get(L)!.push(p);
  }
  const letters = Array.from(map.keys()).sort((a, b) => {
    if (a === "#") return 1;
    if (b === "#") return -1;
    return a.localeCompare(b);
  });
  return letters.map((letter) => ({ letter, peers: map.get(letter)! }));
}

/**
 * 门店通讯录：已屏蔽联系人一律归入末尾「#」组（与 A–Z 索引一致），
 * 组内顺序为未屏蔽的 # 名在前、已屏蔽在后，各自按名称排序。
 */
export function groupPeersByLetterForStore(
  peers: StorePeerRecord[],
  blockedPeerKeys: Set<string>,
): { letter: string; peers: StorePeerRecord[] }[] {
  const map = new Map<string, StorePeerRecord[]>();
  for (const p of peers) {
    const L = blockedPeerKeys.has(p.peerKey) ? "#" : p.sortLetter || "#";
    if (!map.has(L)) map.set(L, []);
    map.get(L)!.push(p);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => {
      const ba = blockedPeerKeys.has(a.peerKey) ? 1 : 0;
      const bb = blockedPeerKeys.has(b.peerKey) ? 1 : 0;
      if (ba !== bb) return ba - bb;
      return (a.name || "").localeCompare(b.name || "", "zh-Hans-CN", { sensitivity: "base" });
    });
  }
  const letters = Array.from(map.keys()).sort((a, b) => {
    if (a === "#") return 1;
    if (b === "#") return -1;
    return a.localeCompare(b);
  });
  return letters.map((letter) => ({ letter, peers: map.get(letter)! }));
}

export const ALPHABET_INDEX = "ABCDEFGHIJKLMNOPQRSTUVWXYZ#".split("");

/** 清理旧版自动插入的 demo 联系人（仅本地 IndexedDB） */
export async function removeLegacyDemoSupportContact(storeUserId: string): Promise<void> {
  const peerKey = makePeerKey("demo-taprootagro-support-ch", "taprootagro_support_demo");
  if (await getPeer(storeUserId, peerKey)) {
    await removePeerAndData(storeUserId, peerKey);
  }
}

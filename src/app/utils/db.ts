// ============================================================================
import { storageGet, storageSet, storageRemove, getStorageHealth, onStorageDegraded } from './safeStorage';
import { errorMonitor } from './errorMonitor';

// ---- Degradation tracking ----

type StorageBackend = 'indexeddb' | 'localstorage' | 'none';

interface StorageStatus {
  backend: StorageBackend;
  idbAvailable: boolean;
  lsHealthy: boolean;
  fallbackCount: number;
  lastFallbackAt: number | null;
}

let _status: StorageStatus = {
  backend: 'indexeddb',
  idbAvailable: true,
  lsHealthy: true,
  fallbackCount: 0,
  lastFallbackAt: null,
};

/** Record an IDB → localStorage fallback and report it to errorMonitor */
function recordFallback(op: string, error: unknown) {
  _status.fallbackCount++;
  _status.lastFallbackAt = Date.now();
  _status.idbAvailable = false;
  _status.backend = _status.lsHealthy ? 'localstorage' : 'none';

  errorMonitor.capture(
    error instanceof Error ? error : new Error(String(error)),
    {
      type: 'manual',
      context: `[TaprootDB] IDB fallback in ${op} (total: ${_status.fallbackCount})`,
    }
  );
}

function recordIDBSuccess() {
  if (!_status.idbAvailable) {
    console.log('[TaprootDB] IndexedDB recovered');
  }
  _status.idbAvailable = true;
  _status.backend = 'indexeddb';
}

/**
 * Get a snapshot of the storage subsystem health.
 * Useful for diagnostic pages, config manager, etc.
 */
export function getStorageStatus(): Readonly<StorageStatus> {
  _status.lsHealthy = getStorageHealth().available;
  return { ..._status };
}

// ---- Table interfaces ----

export interface KVRecord {
  key: string;
  value: string; // JSON-stringified
  encrypted?: boolean;
  updatedAt: number;
}

export interface TransactionRecord {
  id: string;
  data: string; // encrypted JSON of Transaction fields
  updatedAt: number;
}

export interface SyncQueueRecord {
  id: string;
  type: string;
  data: string; // JSON
  timestamp: number;
  status: string;
  retryCount: number;
}

// ---- Minimal Promise-based IndexedDB helpers ----
// Inspired by Jake Archibald's `idb`, inlined to avoid ESM compat issues.

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

interface SimpleDB {
  _raw: IDBDatabase;
  get<T>(store: string, key: string): Promise<T | undefined>;
  getAll<T>(store: string): Promise<T[]>;
  put<T>(store: string, value: T, key?: IDBValidKey): Promise<void>;
  delete(store: string, key: string): Promise<void>;
  /** Execute callback in a readwrite transaction, await tx.done for completion */
  tx(store: string | string[], mode: IDBTransactionMode): {
    store: IDBObjectStore;
    done: Promise<void>;
    objectStore: (name: string) => IDBObjectStore;
  };
  close(): void;
}

function wrapDB(raw: IDBDatabase): SimpleDB {
  return {
    _raw: raw,
    async get<T>(storeName: string, key: string) {
      const tx = raw.transaction(storeName, 'readonly');
      return promisifyRequest(tx.objectStore(storeName).get(key)) as Promise<T | undefined>;
    },
    async getAll<T>(storeName: string) {
      const tx = raw.transaction(storeName, 'readonly');
      return promisifyRequest(tx.objectStore(storeName).getAll()) as Promise<T[]>;
    },
    async put<T>(storeName: string, value: T, key?: IDBValidKey) {
      const tx = raw.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value, key);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    async delete(storeName: string, key: string) {
      const tx = raw.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    tx(storeName: string | string[], mode: IDBTransactionMode) {
      const tx = raw.transaction(storeName, mode);
      const first = Array.isArray(storeName) ? storeName[0] : storeName;
      return {
        store: tx.objectStore(first),
        done: new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        }),
        objectStore: (name: string) => tx.objectStore(name),
      };
    },
    close() {
      raw.close();
    },
  };
}

function openSimpleDB(
  name: string,
  version: number,
  onUpgrade: (db: IDBDatabase, oldVersion: number) => void
): Promise<SimpleDB> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = (ev) => onUpgrade(request.result, ev.oldVersion);
    request.onsuccess = () => resolve(wrapDB(request.result));
    request.onerror = () => {
      const error = request.error;
      // If the existing DB has a higher version (e.g. left over from a previous
      // idb/Dexie wrapper), delete it and retry with our version.
      if (error && error.name === 'VersionError') {
        console.warn(`[TaprootDB] VersionError on "${name}" — deleting stale DB and retrying...`);
        const delReq = indexedDB.deleteDatabase(name);
        delReq.onsuccess = () => {
          const retry = indexedDB.open(name, version);
          retry.onupgradeneeded = (ev) => onUpgrade(retry.result, ev.oldVersion);
          retry.onsuccess = () => resolve(wrapDB(retry.result));
          retry.onerror = () => reject(retry.error);
        };
        delReq.onerror = () => reject(delReq.error);
      } else {
        reject(error);
      }
    };
  });
}

// ---- Database instances ----

const DB_NAME = 'TaprootAgroDB';
const DB_VERSION = 3;
const CRYPTO_KEY_STORE = 'TaprootCryptoKeys';
const CRYPTO_KEY_ID = 'device-master-key';

let _db: SimpleDB | null = null;
let _dbPromise: Promise<SimpleDB> | null = null;

function getDB(): Promise<SimpleDB> {
  if (_db) return Promise.resolve(_db);
  if (_dbPromise) return _dbPromise;

  _dbPromise = openSimpleDB(DB_NAME, DB_VERSION, (raw, oldVersion) => {
    if (!raw.objectStoreNames.contains('keyval')) {
      raw.createObjectStore('keyval', { keyPath: 'key' });
    }
    if (!raw.objectStoreNames.contains('transactions')) {
      const txStore = raw.createObjectStore('transactions', { keyPath: 'id' });
      txStore.createIndex('updatedAt', 'updatedAt', { unique: false });
    }
    if (!raw.objectStoreNames.contains('syncQueue')) {
      const sqStore = raw.createObjectStore('syncQueue', { keyPath: 'id' });
      sqStore.createIndex('status', 'status', { unique: false });
      sqStore.createIndex('timestamp', 'timestamp', { unique: false });
    }
    if (oldVersion < 2) {
      if (!raw.objectStoreNames.contains('storePeers')) {
        const sp = raw.createObjectStore('storePeers', { keyPath: 'id' });
        sp.createIndex('byStoreUser', 'storeUserId', { unique: false });
      }
      if (!raw.objectStoreNames.contains('storeRecents')) {
        const sr = raw.createObjectStore('storeRecents', { keyPath: 'id' });
        sr.createIndex('byStoreUser', 'storeUserId', { unique: false });
        sr.createIndex('byTime', 'lastMessageAt', { unique: false });
      }
      if (!raw.objectStoreNames.contains('storeBlocked')) {
        const sb = raw.createObjectStore('storeBlocked', { keyPath: 'id' });
        sb.createIndex('byStoreUser', 'storeUserId', { unique: false });
      }
      if (!raw.objectStoreNames.contains('storeDeletedThreads')) {
        raw.createObjectStore('storeDeletedThreads', { keyPath: 'id' });
      }
    }
    if (oldVersion < 3) {
      // 聊天本地长留：消息行 + 媒体 blob（云端 24h 自动清空）
      if (!raw.objectStoreNames.contains('chatMessages')) {
        const cm = raw.createObjectStore('chatMessages', { keyPath: 'id' });
        cm.createIndex('byChannel', ['channelName', 'timestamp'], { unique: false });
        cm.createIndex('byChannelOnly', 'channelName', { unique: false });
      }
      if (!raw.objectStoreNames.contains('chatMedia')) {
        const md = raw.createObjectStore('chatMedia', { keyPath: 'url' });
        md.createIndex('byAddedAt', 'addedAt', { unique: false });
      }
    }
  }).then((db) => {
    _db = db;
    db._raw.onclose = () => {
      _db = null;
      _dbPromise = null;
    };
    return db;
  }).catch((err) => {
    _dbPromise = null;
    throw err;
  });

  return _dbPromise;
}

// ---- Web Crypto AES-256-GCM ----

let _cachedKey: CryptoKey | null = null;

/** Get or create the device-bound AES-256-GCM key */
async function getDeviceKey(): Promise<CryptoKey> {
  if (_cachedKey) return _cachedKey;

  try {
    const stored = await loadKeyFromStore();
    if (stored) {
      _cachedKey = stored;
      return stored;
    }
  } catch {
    // Store doesn't exist yet or is corrupted
  }

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  await saveKeyToStore(key);
  _cachedKey = key;
  return key;
}

/** Load CryptoKey from dedicated store */
async function loadKeyFromStore(): Promise<CryptoKey | null> {
  const db = await openSimpleDB(CRYPTO_KEY_STORE, 1, (raw, _oldVer) => {
    if (!raw.objectStoreNames.contains('keys')) {
      raw.createObjectStore('keys');
    }
  });
  try {
    const key = await db.get<CryptoKey>('keys', CRYPTO_KEY_ID);
    return key || null;
  } finally {
    db.close();
  }
}

/** Save CryptoKey to dedicated store */
async function saveKeyToStore(key: CryptoKey): Promise<void> {
  const db = await openSimpleDB(CRYPTO_KEY_STORE, 1, (raw, _oldVer) => {
    if (!raw.objectStoreNames.contains('keys')) {
      raw.createObjectStore('keys');
    }
  });
  try {
    await db.put('keys', key, CRYPTO_KEY_ID);
  } finally {
    db.close();
  }
}

// ---- Encrypt / Decrypt helpers ----

export async function encrypt(plaintext: string): Promise<string> {
  try {
    const key = await getDeviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoded
    );
    const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(cipherBuf), iv.length);
    return arrayBufferToBase64(combined);
  } catch (e) {
    console.error('[TaprootDB] Encryption failed:', e);
    throw e;
  }
}

export async function decrypt(cipherBase64: string): Promise<string> {
  try {
    const key = await getDeviceKey();
    const combined = base64ToArrayBuffer(cipherBase64);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(plainBuf);
  } catch (e) {
    console.error('[TaprootDB] Decryption failed:', e);
    throw e;
  }
}

function arrayBufferToBase64(buf: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---- High-level storage API ----

export async function kvGet(key: string): Promise<string | null> {
  try {
    const db = await getDB();
    const record = await db.get<KVRecord>('keyval', key);
    if (record) return record.value;
  } catch (e) {
    recordFallback('kvGet', e);
    return storageGet(key);
  }
  recordIDBSuccess();
  return storageGet(key);
}

export async function kvPut(key: string, value: string, mirror = true): Promise<void> {
  try {
    const db = await getDB();
    await db.put('keyval', {
      key,
      value,
      encrypted: false,
      updatedAt: Date.now(),
    } as KVRecord);
  } catch (e) {
    recordFallback('kvPut', e);
  }
  if (mirror) {
    storageSet(key, value);
  }
}

export async function kvDelete(key: string, mirror = true): Promise<void> {
  try {
    const db = await getDB();
    await db.delete('keyval', key);
  } catch { /* ignore */ }
  if (mirror) {
    storageRemove(key);
  }
}

export async function kvGetEncrypted(key: string): Promise<string | null> {
  try {
    const db = await getDB();
    const record = await db.get<KVRecord>('keyval', key);
    if (!record) return null;
    if (record.encrypted) {
      return await decrypt(record.value);
    }
    return record.value;
  } catch (e) {
    console.warn('[TaprootDB] kvGetEncrypted failed:', e);
    return null;
  }
}

export async function kvPutEncrypted(key: string, value: string): Promise<void> {
  try {
    const encrypted = await encrypt(value);
    const db = await getDB();
    await db.put('keyval', {
      key,
      value: encrypted,
      encrypted: true,
      updatedAt: Date.now(),
    } as KVRecord);
  } catch (e) {
    console.error('[TaprootDB] kvPutEncrypted failed:', e);
  }
}

// ---- Transactions table (encrypted financial data) ----

export async function saveTransactions(transactions: any[]): Promise<boolean> {
  try {
    const json = JSON.stringify(transactions);
    const encryptedData = await encrypt(json);
    const now = Date.now();

    const db = await getDB();
    const { store, done } = db.tx('transactions', 'readwrite');
    store.clear();
    store.put({
      id: 'all_transactions',
      data: encryptedData,
      updatedAt: now,
    });
    await done;

    try {
      storageSet('accounting_transactions', json);
    } catch { /* quota exceeded is fine — IDB is primary */ }

    return true;
  } catch (e) {
    console.error('[TaprootDB] saveTransactions failed:', e);
    return false;
  }
}

export async function loadTransactions(): Promise<any[] | null> {
  try {
    const db = await getDB();
    const record = await db.get<TransactionRecord>('transactions', 'all_transactions');
    if (record) {
      const json = await decrypt(record.data);
      return JSON.parse(json);
    }
  } catch (e) {
    recordFallback('loadTransactions', e);
  }

  try {
    const raw = storageGet('accounting_transactions');
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }

  return null;
}

// ---- Sync Queue table ----

export async function loadSyncQueue(): Promise<SyncQueueRecord[]> {
  try {
    const db = await getDB();
    return await db.getAll<SyncQueueRecord>('syncQueue');
  } catch (e) {
    recordFallback('loadSyncQueue', e);
    try {
      const raw = storageGet('taproot-sync-queue');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
}

export async function saveSyncQueue(items: SyncQueueRecord[]): Promise<void> {
  try {
    const db = await getDB();
    const { store, done } = db.tx('syncQueue', 'readwrite');
    store.clear();
    for (const item of items) {
      store.put(item);
    }
    await done;
  } catch (e) {
    recordFallback('saveSyncQueue', e);
    try {
      storageSet('taproot-sync-queue', JSON.stringify(items));
    } catch { /* ignore */ }
  }
}

export async function addToSyncQueue(item: SyncQueueRecord): Promise<void> {
  try {
    const db = await getDB();
    await db.put('syncQueue', item);
  } catch (e) {
    recordFallback('addToSyncQueue', e);
    try {
      const raw = storageGet('taproot-sync-queue');
      const queue = raw ? JSON.parse(raw) : [];
      queue.push(item);
      storageSet('taproot-sync-queue', JSON.stringify(queue));
    } catch { /* ignore */ }
  }
}

// ---- Auth data (encrypted backup alongside safeStorage) ----

/** Matches supabaseBrowser auth.storageKey — full Supabase session JSON in localStorage */
export const SUPABASE_AUTH_STORAGE_KEY = 'taprootagro-auth';
const SUPABASE_SESSION_DEXIE_KEY = 'supabase_session_mirror';

/** Encrypt-backup taprootagro-auth for recovery when localStorage is partially cleared. */
export async function mirrorSupabaseSessionToDexie(): Promise<void> {
  try {
    const raw = storageGet(SUPABASE_AUTH_STORAGE_KEY);
    if (!raw) return;
    await kvPutEncrypted(SUPABASE_SESSION_DEXIE_KEY, raw);
  } catch (e) {
    console.warn('[TaprootDB] mirrorSupabaseSessionToDexie failed:', e);
  }
}

export async function getSupabaseSessionBackupFromDexie(): Promise<string | null> {
  try {
    return await kvGetEncrypted(SUPABASE_SESSION_DEXIE_KEY);
  } catch (e) {
    console.warn('[TaprootDB] getSupabaseSessionBackupFromDexie failed:', e);
    return null;
  }
}

export async function clearSupabaseSessionDexieBackup(): Promise<void> {
  try {
    await kvPutEncrypted(SUPABASE_SESSION_DEXIE_KEY, '');
  } catch {
    /* ignore */
  }
}

export async function mirrorAuthToDexie(): Promise<void> {
  try {
    const authData: Record<string, string> = {};
    const keys = ['isLoggedIn', 'agri_user_numeric_id', 'agri_server_user_id', 'agri_auth_source'];
    for (const k of keys) {
      const val = storageGet(k);
      if (val) authData[k] = val;
    }
    if (Object.keys(authData).length > 0) {
      await kvPutEncrypted('auth_mirror', JSON.stringify(authData));
    }
  } catch (e) {
    console.warn('[TaprootDB] mirrorAuthToDexie failed:', e);
  }
}

export async function restoreAuthFromDexie(): Promise<boolean> {
  try {
    const json = await kvGetEncrypted('auth_mirror');
    if (!json) return false;
    const authData = JSON.parse(json) as Record<string, unknown>;
    for (const [k, v] of Object.entries(authData)) {
      if (typeof v === 'string') {
        storageSet(k, v);
      }
    }
    // Avoid false "logged in" when Supabase session is missing (hydrate runs in auth layer).
    if (authData.isLoggedIn === 'true' && !storageGet(SUPABASE_AUTH_STORAGE_KEY)) {
      const sessionBackup = await getSupabaseSessionBackupFromDexie();
      if (sessionBackup) {
        storageSet(SUPABASE_AUTH_STORAGE_KEY, sessionBackup);
      } else {
        storageRemove('isLoggedIn');
      }
    }
    console.log('[TaprootDB] Auth restored from encrypted backup');
    return true;
  } catch (e) {
    console.warn('[TaprootDB] restoreAuthFromDexie failed:', e);
    return false;
  }
}

// ---- One-time migration: localStorage → IndexedDB ----

const MIGRATION_DONE_KEY = '__taproot_idb_migrated__';

export async function migrateFromLocalStorage(): Promise<void> {
  try {
    const db = await getDB();
    const migrated = await db.get<KVRecord>('keyval', MIGRATION_DONE_KEY);
    if (migrated) return;

    console.log('[TaprootDB] Starting one-time migration from localStorage...');

    const txRaw = storageGet('accounting_transactions');
    if (txRaw) {
      try {
        const transactions = JSON.parse(txRaw);
        if (Array.isArray(transactions)) {
          await saveTransactions(transactions);
          console.log(`[TaprootDB] Migrated ${transactions.length} transactions`);
        }
      } catch (e) {
        console.warn('[TaprootDB] Transaction migration failed:', e);
      }
    }

    const sqRaw = storageGet('taproot-sync-queue');
    if (sqRaw) {
      try {
        const queue = JSON.parse(sqRaw);
        if (Array.isArray(queue)) {
          await saveSyncQueue(queue);
          console.log(`[TaprootDB] Migrated ${queue.length} sync queue items`);
        }
      } catch (e) {
        console.warn('[TaprootDB] Sync queue migration failed:', e);
      }
    }

    await mirrorAuthToDexie();

    const addr = storageGet('pickup-address');
    if (addr) {
      await kvPutEncrypted('pickup-address', addr);
      console.log('[TaprootDB] Migrated pickup address (encrypted)');
    }

    await db.put('keyval', {
      key: MIGRATION_DONE_KEY,
      value: 'true',
      encrypted: false,
      updatedAt: Date.now(),
    } as KVRecord);

    console.log('[TaprootDB] Migration complete');
  } catch (e) {
    console.error('[TaprootDB] Migration error (non-fatal):', e);
  }
}

/** Expose main app DB for store chat directory (storePeers / storeRecents / …). */
export function getTaprootAgroIDB(): Promise<SimpleDB> {
  return getDB();
}

// ---- Init ----

let _initPromise: Promise<void> | null = null;

export function initTaprootDB(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    // Subscribe to localStorage degradation events
    onStorageDegraded((health) => {
      _status.lsHealthy = false;
      if (!_status.idbAvailable) _status.backend = 'none';
      errorMonitor.capture(
        new Error(`localStorage degraded: ${health.failureCount} failures, last op: ${health.lastFailureOp}`),
        { type: 'manual', context: '[TaprootDB] localStorage degradation detected' }
      );
    });

    try {
      await getDB();
      recordIDBSuccess();
      await migrateFromLocalStorage();
      if (!storageGet('isLoggedIn')) {
        await restoreAuthFromDexie();
      } else if (!storageGet(SUPABASE_AUTH_STORAGE_KEY)) {
        const sessionBackup = await getSupabaseSessionBackupFromDexie();
        if (sessionBackup) {
          storageSet(SUPABASE_AUTH_STORAGE_KEY, sessionBackup);
        }
      }
      console.log('[TaprootDB] Initialized successfully');
    } catch (e) {
      recordFallback('initTaprootDB', e);
      console.error('[TaprootDB] Init failed (app continues with safeStorage fallback):', e);
    }
  })();
  return _initPromise;
}
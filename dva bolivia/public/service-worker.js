// ============================================================
// PWA Service Worker - Cache-First + Offline-Ready
// ============================================================
// Strategy:
//   - Same-origin: Cache-first for instant load
//   - Cross-origin images: Cache-first with network fallback
//   - Cross-origin CDN (jsDelivr etc): Cache-first for ONNX Runtime
//   - Navigation: Always resolves to cached index.html (SPA)
//   - Once per day (first open), background-check server for updates
//   - Offline: Serve everything from cache, placeholder for uncached images
//   - Remote config: cache strategy override, maintenance mode, feature flags,
//     force update/reload, cache purge, kill switch, announcements
// ============================================================

const CACHE_VERSION = 'v13'; // cross-origin images cache-first; same as PWA static assets
const CACHE_PREFIX = 'taproot-agro';
const CACHE_NAME = `${CACHE_PREFIX}-${CACHE_VERSION}`;
const IMG_CACHE_NAME = `${CACHE_PREFIX}-images-${CACHE_VERSION}`;
const CDN_CACHE_NAME = `${CACHE_PREFIX}-cdn-${CACHE_VERSION}`;

// Remote config endpoint
// Default: Central config server (free tier).
// Self-hosted / paid customers: replace this URL before deploying,
// or set it via your build pipeline.
const REMOTE_CONFIG_URL = self.__REMOTE_CONFIG_URL || 'https://www.taprootagro.com/taprootagro/globalpublic/customer.json';

// Remote config cache key (stored in CacheStorage for SW-side access)
const REMOTE_CONFIG_CACHE_KEY = '__taproot_remote_config__';

// Daily check key stored in cache
const DAILY_CHECK_KEY = '__taproot_daily_check__';

// App shell - critical resources to pre-cache on install
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json'
];

// Resources that should NEVER be intercepted by the SW
const SW_BYPASS_PATHS = [
  '/service-worker.js',
  '/clear-cache.html',
  '/sw-reset',
];

// Default maximum entries per cache (can be overridden by remote config)
const DEFAULT_MAX_CACHE_ENTRIES = 200;
const DEFAULT_MAX_IMG_CACHE_ENTRIES = 300;
const MAX_CDN_CACHE_ENTRIES = 50;

// Default network timeout (can be overridden by remote config)
const DEFAULT_NETWORK_TIMEOUT = 20000;

// Navigation timeouts (can be overridden by remote config → navTimeoutMs)
// With cached index.html: short timeout — fall back to cache quickly if network is slow
const DEFAULT_NAV_TIMEOUT_WITH_CACHE = 3000;
// Without cached index.html: longer timeout — wait for network since there's no fallback
const DEFAULT_NAV_TIMEOUT_WITHOUT_CACHE = 15000;

// ============================================================
// LIGHTWEIGHT I18N — Top 6 languages + RTL support
// Language is set by client via postMessage('SET_LANGUAGE')
// Falls back to 'en' if not set
// ============================================================
let currentLang = 'en';

const SW_TRANSLATIONS = {
  en: {
    offline: 'offline',
    imageNotCached: 'Image not cached',
    maintenance: 'System Maintenance',
    maintenanceMsg: 'We are currently performing maintenance. Please check back soon.',
    estimatedEnd: 'Estimated completion',
    retry: 'Retry',
    noNetwork: 'No Network',
    noNetworkMsg: 'Please check your connection. The app will work once you reconnect.',
    somethingWrong: 'Something went wrong',
    somethingWrongMsg: 'The app encountered an error.',
    resetApp: 'Reset App',
    resetting: 'Resetting app...',
    backingUp: 'Backing up user data...',
    unregisteringSW: 'Unregistering Service Worker...',
    clearingCache: 'Clearing cache...',
    cleaningDB: 'Cleaning databases...',
    clearingStorage: 'Clearing local storage...',
    restoringData: 'Restoring user data...',
    resetComplete: 'Reset Complete',
    swUnregistered: 'Service Worker unregistered, all caches cleared',
    dataPreserved: 'User data safely preserved',
    openApp: 'Open App',
    resetFailed: 'Reset Failed',
    manualClear: 'Please try manually clearing browser data, or contact support',
    notification: 'You have a new notification',
  },
  zh: {
    offline: '离线',
    imageNotCached: '图片未缓存',
    maintenance: '系统维护中',
    maintenanceMsg: '我们正在进行系统维护，请稍后再试。',
    estimatedEnd: '预计完成时间',
    retry: '重试',
    noNetwork: '无网络连接',
    noNetworkMsg: '请检查网络连接，恢复后应用将自动可用。',
    somethingWrong: '出了点问题',
    somethingWrongMsg: '应用遇到了一个错误。',
    resetApp: '重置应用',
    resetting: '正在重置应用...',
    backingUp: '正在备份用户数据...',
    unregisteringSW: '正在注销 Service Worker...',
    clearingCache: '正在清除缓存...',
    cleaningDB: '正在清理数据库...',
    clearingStorage: '正在清理本地存储...',
    restoringData: '正在恢复用户数据...',
    resetComplete: '重置完成',
    swUnregistered: 'Service Worker 已注销，所有缓存已清除',
    dataPreserved: '✓ 用户数据已安全保留',
    openApp: '打开应用',
    resetFailed: '重置失败',
    manualClear: '请尝试手动清除浏览器数据，或联系技术支持',
    notification: '您有一条新通知',
  },
  fr: {
    offline: 'hors ligne',
    imageNotCached: 'Image non mise en cache',
    maintenance: 'Maintenance du système',
    maintenanceMsg: 'Nous effectuons actuellement une maintenance. Veuillez réessayer plus tard.',
    estimatedEnd: 'Fin estimée',
    retry: 'Réessayer',
    noNetwork: 'Pas de réseau',
    noNetworkMsg: 'Veuillez vérifier votre connexion. L\'application fonctionnera dès la reconnexion.',
    somethingWrong: 'Un problème est survenu',
    somethingWrongMsg: 'L\'application a rencontré une erreur.',
    resetApp: 'Réinitialiser',
    resetting: 'Réinitialisation...',
    backingUp: 'Sauvegarde des données...',
    unregisteringSW: 'Désinscription du Service Worker...',
    clearingCache: 'Nettoyage du cache...',
    cleaningDB: 'Nettoyage des bases de données...',
    clearingStorage: 'Nettoyage du stockage local...',
    restoringData: 'Restauration des données...',
    resetComplete: 'Réinitialisation terminée',
    swUnregistered: 'Service Worker désinscrit, tous les caches vidés',
    dataPreserved: '✓ Données utilisateur préservées',
    openApp: 'Ouvrir l\'application',
    resetFailed: 'Échec de la réinitialisation',
    manualClear: 'Essayez de vider manuellement les données du navigateur ou contactez le support',
    notification: 'Vous avez une nouvelle notification',
  },
  es: {
    offline: 'sin conexión',
    imageNotCached: 'Imagen no almacenada',
    maintenance: 'Mantenimiento del sistema',
    maintenanceMsg: 'Estamos realizando mantenimiento. Por favor, vuelva a intentarlo más tarde.',
    estimatedEnd: 'Finalización estimada',
    retry: 'Reintentar',
    noNetwork: 'Sin red',
    noNetworkMsg: 'Verifique su conexión. La aplicación funcionará cuando se reconecte.',
    somethingWrong: 'Algo salió mal',
    somethingWrongMsg: 'La aplicación encontró un error.',
    resetApp: 'Restablecer',
    resetting: 'Restableciendo...',
    backingUp: 'Respaldando datos...',
    unregisteringSW: 'Cancelando Service Worker...',
    clearingCache: 'Limpiando caché...',
    cleaningDB: 'Limpiando bases de datos...',
    clearingStorage: 'Limpiando almacenamiento...',
    restoringData: 'Restaurando datos...',
    resetComplete: 'Restablecimiento completo',
    swUnregistered: 'Service Worker cancelado, todos los cachés eliminados',
    dataPreserved: '✓ Datos de usuario preservados',
    openApp: 'Abrir aplicación',
    resetFailed: 'Error en restablecimiento',
    manualClear: 'Intente borrar los datos del navegador manualmente o contacte al soporte',
    notification: 'Tienes una nueva notificación',
  },
  ar: {
    offline: 'غير متصل',
    imageNotCached: 'الصورة غير مخزنة',
    maintenance: 'صيانة النظام',
    maintenanceMsg: 'نقوم حالياً بإجراء صيانة. يرجى المحاولة لاحقاً.',
    estimatedEnd: 'الانتهاء المتوقع',
    retry: 'إعادة المحاولة',
    noNetwork: 'لا يوجد اتصال',
    noNetworkMsg: 'يرجى التحقق من اتصاك. سيعمل التطبيق عند إعادة الاتصال.',
    somethingWrong: 'حدث خطأ ما',
    somethingWrongMsg: 'واجه التطبيق خطأً.',
    resetApp: 'إعادة تعيين',
    resetting: 'جارٍ إعادة التعيين...',
    backingUp: 'جارٍ النسخ الاحتياطي...',
    unregisteringSW: 'جارٍ إلغاء تسجيل Service Worker...',
    clearingCache: 'جارٍ مسح الذاكرة المؤقتة...',
    cleaningDB: 'جارٍ تنظيف قواعد البيانات...',
    clearingStorage: 'جارٍ تنظيف التخزين المحلي...',
    restoringData: 'جارٍ استعادة البيانات...',
    resetComplete: 'اكتملت إعادة التعيين',
    swUnregistered: 'تم إلغاء تسجيل Service Worker ومسح جميع الذاكرة المؤقتة',
    dataPreserved: '✓ تم الحفاظ على بيانات المستخدم بأمان',
    openApp: 'فتح التطبيق',
    resetFailed: 'فشلت إعادة التعيين',
    manualClear: 'يرجى محاولة مسح بيانات المتصفح يدوياً أو الاتصال بالدعم',
    notification: 'لديك إشعار جديد',
  },
  sw: {
    offline: 'nje ya mtandao',
    imageNotCached: 'Picha haijahifadhiwa',
    maintenance: 'Matengenezo ya Mfumo',
    maintenanceMsg: 'Tunafanya matengenezo kwa sasa. Tafadhali jaribu tena baadaye.',
    estimatedEnd: 'Wakati wa kumaliza',
    retry: 'Jaribu tena',
    noNetwork: 'Hakuna Mtandao',
    noNetworkMsg: 'Tafadhali angalia muunganisho wako. Programu itafanya kazi ukiunganishwa tena.',
    somethingWrong: 'Kitu kilienda vibaya',
    somethingWrongMsg: 'Programu ilikutana na hitilafu.',
    resetApp: 'Weka upya',
    resetting: 'Inaweka upya...',
    backingUp: 'Inahifadhi data...',
    unregisteringSW: 'Inafuta usajili wa Service Worker...',
    clearingCache: 'Inasafisha cache...',
    cleaningDB: 'Inasafisha hifadhidata...',
    clearingStorage: 'Inasafisha hifadhi...',
    restoringData: 'Inarejesha data...',
    resetComplete: 'Uwekaji upya umekamilika',
    swUnregistered: 'Service Worker imefutwa, cache zote zimesafishwa',
    dataPreserved: '✓ Data ya mtumiaji imehifadhiwa salama',
    openApp: 'Fungua Programu',
    resetFailed: 'Uwekaji upya umeshindikana',
    manualClear: 'Tafadhali jaribu kusafisha data ya kivinjari mwenyewe au wasiliana na msaada',
    notification: 'Una arifa mpya',
  },
};

/**
 * Get a translated string. Falls back to English if key/lang not found.
 */
function swt(key) {
  const lang = SW_TRANSLATIONS[currentLang] || SW_TRANSLATIONS.en;
  return lang[key] || SW_TRANSLATIONS.en[key] || key;
}

/**
 * Detect if the current language is RTL.
 */
function isRTL() {
  return currentLang === 'ar' || currentLang === 'fa' || currentLang === 'ur';
}

/**
 * Get the dir attribute value for HTML pages.
 */
function dirAttr() {
  return isRTL() ? ' dir="rtl"' : '';
}

// Cross-origin domains allowed to be cached
const CACHEABLE_IMAGE_HOSTS = [
  'images.unsplash.com',
  'placehold.co',
  'plus.unsplash.com',
];

const CACHEABLE_CDN_HOSTS = [
  'cdn.jsdelivr.net',       // ONNX Runtime WASM
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'esm.sh',                 // Supabase and other ESM dynamically imported modules
];

// ============================================================
// ACTIVE REMOTE CONFIG (module-level, updated by checkRemoteConfig)
// ============================================================
let activeConfig = null;

/**
 * Load the cached remote config from CacheStorage into the module variable.
 * Called on SW startup and after each config fetch.
 */
async function loadCachedConfig() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(REMOTE_CONFIG_CACHE_KEY);
    if (response) {
      activeConfig = await response.json();
      console.log('[SW] Loaded cached remote config:', activeConfig?.version || 'unknown');
    }
  } catch {
    activeConfig = null;
  }
}

/**
 * Persist the remote config to CacheStorage (SW-accessible, unlike localStorage).
 */
async function saveCachedConfig(config) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(REMOTE_CONFIG_CACHE_KEY, new Response(
      JSON.stringify(config),
      { headers: { 'Content-Type': 'application/json' } }
    ));
    activeConfig = config;
  } catch (err) {
    console.warn('[SW] Failed to cache remote config:', err);
  }
}

/**
 * Get a config value with fallback to default.
 */
function configVal(key, defaultVal) {
  if (!activeConfig) return defaultVal;
  const val = activeConfig[key];
  return val !== undefined && val !== null ? val : defaultVal;
}

// ============================================================
// EMERGENCY RECOVERY
// ============================================================

// ============================================================
// HELPER - Strip redirect flag from responses
// ============================================================
function stripRedirect(response) {
  if (!response || !response.redirected) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

async function safeCacheAdd(cache, url) {
  try {
    const response = await fetch(url);
    if (response.ok) {
      await cache.put(url, stripRedirect(response));
    }
  } catch (err) {
    console.warn(`[SW] Failed to cache: ${url}`, err);
  }
}

// ============================================================
// DAILY CHECK HELPER
// ============================================================
function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function getCheckIntervalKey() {
  // Support custom check intervals (e.g., every 6 hours instead of daily)
  const hours = configVal('checkIntervalHours', 24);
  if (hours >= 24) return getTodayDateString(); // Daily
  // Sub-daily: use hour-based bucketing
  const now = new Date();
  const bucket = Math.floor(now.getHours() / Math.max(1, Math.min(hours, 24)));
  return `${getTodayDateString()}-${bucket}`;
}

async function hasCheckedThisPeriod() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(DAILY_CHECK_KEY);
    if (!response) return false;
    const data = await response.json();
    return data.date === getCheckIntervalKey();
  } catch {
    return false;
  }
}

async function markCheckedThisPeriod() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const body = JSON.stringify({ date: getCheckIntervalKey() });
    await cache.put(DAILY_CHECK_KEY, new Response(body, {
      headers: { 'Content-Type': 'application/json' }
    }));
  } catch { /* Silently fail */ }
}

// ============================================================
// 1x1 transparent PNG placeholder for offline uncached images
// ============================================================
const OFFLINE_IMAGE_PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">' +
  '<rect fill="#f0fdf4" width="400" height="300"/>' +
  '<text x="200" y="140" text-anchor="middle" fill="#059669" font-family="system-ui" font-size="16">Offline</text>' +
  '<text x="200" y="165" text-anchor="middle" fill="#6b7280" font-family="system-ui" font-size="12">Image not cached</text>' +
  '</svg>'
);

function createOfflineImageResponse() {
  const offlineText = swt('offline');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">' +
    '<rect fill="#f0fdf4" width="400" height="300"/>' +
    '<path d="M185 130 l15-20 l15 20 l-7 0 l0 15 l-16 0 l0-15z" fill="#d1d5db"/>' +
    '<text x="200" y="170" text-anchor="middle" fill="#9ca3af" font-family="system-ui" font-size="11">' + offlineText + '</text>' +
    '</svg>';
  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-store'
    }
  });
}

// ============================================================
// MAINTENANCE MODE PAGE
// ============================================================
function createMaintenancePage(config) {
  const m = config?.maintenance || {};
  // Use remote config message if provided, otherwise use i18n defaults
  const title = m.title || swt('maintenance');
  const message = m.message || swt('maintenanceMsg');
  const estimatedEnd = m.estimatedEnd ? new Date(m.estimatedEnd) : null;
  const etaStr = estimatedEnd
    ? `<p style="color:#6b7280;margin-top:0.5rem;font-size:0.8rem">${swt('estimatedEnd')}: ${estimatedEnd.toLocaleString()}</p>`
    : '';

  const html = '<!DOCTYPE html><html' + dirAttr() + '><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Maintenance</title>' +
    '<style>*{margin:0;padding:0;box-sizing:border-box}body{display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,-apple-system,sans-serif;background:#f0fdf4;color:#065f46;text-align:center;padding:2rem}' +
    '.card{background:white;border-radius:1rem;padding:2rem;box-shadow:0 4px 20px rgba(0,0,0,0.08);max-width:360px;width:100%}' +
    '.icon{width:64px;height:64px;background:#fef3c7;border-radius:1rem;display:flex;align-items:center;justify-content:center;margin:0 auto 1rem}' +
    'h2{margin-bottom:0.5rem;color:#065f46}p{color:#374151;margin-bottom:0.5rem;font-size:0.875rem}' +
    'button{padding:0.75rem 1.5rem;background:#10b981;color:white;border:none;border-radius:0.75rem;cursor:pointer;font-size:0.875rem;width:100%;margin-top:1rem}' +
    'button:active{background:#059669}</style></head>' +
    '<body><div class="card">' +
    '<div class="icon"><svg width="32" height="32" fill="none" stroke="#d97706" stroke-width="2" viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg></div>' +
    '<h2>' + title + '</h2>' +
    '<p>' + message + '</p>' +
    etaStr +
    '<button onclick="location.reload()">' + swt('retry') + '</button>' +
    '</div></body></html>';

  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// ============================================================
// CACHE STRATEGY MATCHING
// ============================================================

/**
 * Check if a URL pathname matches any pattern in a list.
 * Patterns support prefix matching: "/api/prices" matches "/api/prices/wheat"
 */
function matchesPathPattern(pathname, patterns) {
  if (!patterns || !Array.isArray(patterns) || patterns.length === 0) return false;
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string') return false;
    // Exact or prefix match
    return pathname === pattern || pathname.startsWith(pattern + '/') || pathname.startsWith(pattern);
  });
}

/** Vite hashed build assets — network-first when online to avoid stale chunk after deploy */
function isHashedBuildAsset(pathname) {
  if (!pathname.startsWith('/assets/')) return false;
  const ext = pathname.split('.').pop()?.toLowerCase();
  return ext === 'js' || ext === 'css';
}

function discoverChunkUrlsFromHtml(html) {
  const chunkUrls = [];
  const scriptMatches = html.matchAll(/(?:src|href)=["'](\/(?:assets\/[^"']+))['"]/g);
  for (const match of scriptMatches) {
    chunkUrls.push(match[1]);
  }
  const preloadMatches = html.matchAll(/rel=["']modulepreload["'][^>]*href=["']([^"']+)['"]/g);
  for (const match of preloadMatches) {
    chunkUrls.push(match[1]);
  }
  return [...new Set(chunkUrls)];
}

async function precacheAssetsFromIndexHtml(cache, indexResponse) {
  const html = await indexResponse.clone().text();
  const chunkUrls = discoverChunkUrlsFromHtml(html);
  if (chunkUrls.length > 0) {
    console.log(`[SW] Pre-caching ${chunkUrls.length} asset chunks from index.html`);
    await Promise.allSettled(chunkUrls.map((url) => safeCacheAdd(cache, url)));
  }
  return chunkUrls.length;
}

/** Fetch fresh index.html + referenced /assets/* into CACHE_NAME (used before SKIP_WAITING) */
async function precacheUpdateShell() {
  const cache = await caches.open(CACHE_NAME);
  const indexResponse = await fetch('/index.html', { cache: 'no-store' });
  if (!indexResponse.ok) {
    throw new Error('Failed to fetch index.html: HTTP ' + indexResponse.status);
  }
  const clean = stripRedirect(indexResponse);
  await cache.put('/index.html', clean.clone());
  await cache.put('/', clean.clone());
  const assetCount = await precacheAssetsFromIndexHtml(cache, clean);
  console.log('[SW] Update shell pre-cached, assets:', assetCount);
  return { ok: true, assetCount };
}

/**
 * Determine the cache strategy for a same-origin request based on remote config.
 * Returns: 'cache-first' (default) | 'network-first' | 'network-only' | 'no-cache'
 */
function getStrategyForPath(pathname) {
  const cs = activeConfig?.cacheStrategy;
  if (!cs) return 'cache-first';

  if (matchesPathPattern(pathname, cs.networkOnly)) return 'network-only';
  if (matchesPathPattern(pathname, cs.noCache)) return 'no-cache';
  if (matchesPathPattern(pathname, cs.networkFirst)) return 'network-first';
  return 'cache-first';
}

// ============================================================
// INSTALL
// ============================================================
self.addEventListener('install', (event) => {
  console.log(`[SW] Installing ${CACHE_VERSION}...`);
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      console.log('[SW] Pre-caching app shell');
      await Promise.allSettled(
        APP_SHELL.map((url) => safeCacheAdd(cache, url))
      );

      // Auto-discover and pre-cache all JS/CSS chunks referenced by index.html
      try {
        const indexResponse = await caches.match('/index.html') || await fetch('/index.html');
        if (indexResponse && indexResponse.ok !== false) {
          await precacheAssetsFromIndexHtml(cache, indexResponse);
        }
      } catch (err) {
        console.warn('[SW] Auto-discovery of chunks failed (non-blocking):', err);
      }

      // Load any cached remote config
      await loadCachedConfig();
    })().then(() => {
      // First install (no active SW): take over immediately to satisfy
      // Chromium/Edge PWA installability without a manual refresh.
      // Update scenario (active SW exists): wait for client to send SKIP_WAITING
      // (user clicks update banner) to avoid auto-refresh and chunk-not-found crashes.
      if (!self.registration.active) {
        self.skipWaiting();
      }
    })
  );
});

// ============================================================
// ACTIVATE - Clean up old caches
// ============================================================
self.addEventListener('activate', (event) => {
  console.log(`[SW] Activating ${CACHE_VERSION}...`);
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      console.log('[SW] Claimed clients');

      // Load remote config into memory
      await loadCachedConfig();

      // Pre-fetch fresh index.html
      try {
        const cache = await caches.open(CACHE_NAME);
        const indexResponse = await fetch('/index.html', { cache: 'no-store' });
        if (indexResponse.ok) {
          const clean = stripRedirect(indexResponse);
          await cache.put('/index.html', clean.clone());
          await cache.put('/', clean.clone());
          console.log('[SW] Cached fresh index.html during activation');
        }
      } catch (err) {
        console.warn('[SW] Failed to pre-cache index.html during activation:', err);
      }

      // Delete old caches (all prefixed caches from previous versions)
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith(CACHE_PREFIX) && 
            name !== CACHE_NAME && 
            name !== IMG_CACHE_NAME && 
            name !== CDN_CACHE_NAME)
          .map((name) => {
            console.log(`[SW] Deleting old cache: ${name}`);
            return caches.delete(name);
          })
      );
      console.log('[SW] Activation complete');
    })()
  );
});

// ============================================================
// FETCH - Multi-strategy routing
// ============================================================
let dailyCheckTriggered = false;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip API endpoints (same-origin)
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // ---- Bypass paths ----
  if (url.origin === self.location.origin && SW_BYPASS_PATHS.includes(url.pathname)) {
    if (url.pathname === '/sw-reset') {
      event.respondWith(handleSwReset());
    }
    return;
  }

  // ---- Maintenance mode check (intercept navigation) ----
  if (request.mode === 'navigate' && activeConfig?.maintenance?.enabled) {
    const allowPaths = activeConfig.maintenance.allowPaths || [];
    const isAllowed = SW_BYPASS_PATHS.includes(url.pathname) ||
      matchesPathPattern(url.pathname, allowPaths);
    if (!isAllowed) {
      event.respondWith(createMaintenancePage(activeConfig));
      return;
    }
  }

  // Trigger periodic update check (non-blocking)
  if (!dailyCheckTriggered) {
    dailyCheckTriggered = true;
    event.waitUntil(triggerDailyCheck());
  }

  // ----- Same-origin requests -----
  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') {
      event.respondWith(safeRespond(() => handleNavigation(), request));
      return;
    }

    // Check remote config for cache strategy override
    const strategy = getStrategyForPath(url.pathname);

    if (strategy === 'network-only') {
      // Bypass cache entirely, go straight to network
      return; // Let browser handle it
    }

    if (strategy === 'no-cache') {
      // Fetch from network, don't cache the response
      event.respondWith(safeRespond(() => fetch(request), request));
      return;
    }

    if (strategy === 'network-first') {
      event.respondWith(safeRespond(() => networkFirstStrategy(request, CACHE_NAME), request));
      return;
    }

    // Hashed JS/CSS: network-first when online (avoids stale chunks after deploy)
    if (isHashedBuildAsset(url.pathname)) {
      event.respondWith(safeRespond(() => networkFirstStrategy(request, CACHE_NAME), request));
      return;
    }

    // Default: cache-first
    const maxEntries = configVal('maxCacheEntries', DEFAULT_MAX_CACHE_ENTRIES);
    event.respondWith(safeRespond(() => cacheFirstStrategy(request, CACHE_NAME, maxEntries), request));
    return;
  }

  // ----- Cross-origin: Cacheable CDN (ONNX Runtime WASM, JS libraries) -----
  if (CACHEABLE_CDN_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    event.respondWith(safeRespond(() => cacheFirstStrategy(request, CDN_CACHE_NAME, MAX_CDN_CACHE_ENTRIES), request));
    return;
  }

  // ----- Cross-origin: Cacheable images -----
  if (CACHEABLE_IMAGE_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    event.respondWith(safeRespond(() => cacheFirstImageStrategy(request), request));
    return;
  }

  // ----- 其余跨域：图片一律走 cacheFirstImageStrategy（含 no-cors opaque，便于 Supabase Storage / 自建 CDN 开屏与 Banner）-----
  if (isImageRequest(request, url)) {
    event.respondWith(safeRespond(() => cacheFirstImageStrategy(request), request));
    return;
  }
});

// ============================================================
// SAFE RESPOND WRAPPER
// ============================================================
async function safeRespond(handler, originalRequest) {
  try {
    const response = await handler();
    if (response && response.status !== undefined) {
      return response;
    }
    throw new Error('Invalid response from handler');
  } catch (error) {
    console.error('[SW] Response handler failed, falling through to network:', error);
    try {
      return await fetch(originalRequest);
    } catch {
      const url = new URL(originalRequest.url);
      if (isImageRequest(originalRequest, url)) {
        return createOfflineImageResponse();
      }
      
      if (url.pathname.endsWith('.tsx') || url.pathname.endsWith('.ts') || url.pathname.endsWith('.js')) {
         return new Response('console.error("Resource load failed: ' + url.pathname + '");', {
           status: 503,
           headers: { 'Content-Type': 'application/javascript' }
         });
      }

      if (url.pathname.endsWith('.css')) {
        return new Response('/* offline */', {
          status: 503,
          headers: { 'Content-Type': 'text/css' }
        });
      }

      if (originalRequest.mode === 'navigate') {
        return createOfflineFallbackPage();
      }

      return new Response('Offline - Resource not cached', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  }
}

// ============================================================
// Helper: detect image requests
// ============================================================
function isImageRequest(request, url) {
  const accept = request.headers.get('accept') || '';
  if (accept.includes('image/')) return true;
  const ext = url.pathname.split('.').pop()?.toLowerCase();
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'avif'].includes(ext || '');
}

// ============================================================
// EMERGENCY RESET - /sw-reset endpoint
// ============================================================
async function handleSwReset() {
  // Pre-resolve translated strings and inject into the page as JSON
  var ri = {
    resetting: swt('resetting'), backingUp: swt('backingUp'),
    unregisteringSW: swt('unregisteringSW'), clearingCache: swt('clearingCache'),
    cleaningDB: swt('cleaningDB'), clearingStorage: swt('clearingStorage'),
    restoringData: swt('restoringData'), resetComplete: swt('resetComplete'),
    swUnregistered: swt('swUnregistered'), dataPreserved: swt('dataPreserved'),
    openApp: swt('openApp'), resetFailed: swt('resetFailed'),
    manualClear: swt('manualClear'), retry: swt('retry'),
  };
  var tJson = JSON.stringify(ri);

  const html = '<!DOCTYPE html>' +
'<html' + dirAttr() + '><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>Reset</title></head>' +
'<body style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui;background:#f0fdf4;color:#065f46;text-align:center;padding:2rem">' +
'<div id="status">' +
'<svg style="width:48px;height:48px;margin:0 auto 1rem;animation:spin 1s linear infinite" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><circle cx="12" cy="12" r="10" opacity="0.3"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>' +
'<style>@keyframes spin{to{transform:rotate(360deg)}}</style>' +
'<p id="message">' + ri.resetting + '</p>' +
'</div>' +
'<script>' +
'(async function(){' +
'var s=document.getElementById("status");' +
'var m=document.getElementById("message");' +
'var t=' + tJson + ';' +
    'try{' +
    'm.textContent=t.backingUp;var b={};' +
    'var ck=["isLoggedIn","agri_user_numeric_id","agri_server_user_id","agri_auth_source","taprootagro-auth","agri_access_token","accounting_transactions","taproot-sync-queue","pickup-address","app-language","taproot_home_config"];' +
    'for(var k of ck){var v=localStorage.getItem(k);if(v)b[k]=v;}' +
    'if(Object.keys(b).length>0){sessionStorage.setItem("__taproot_reset_backup__",JSON.stringify(b));}' +
    'm.textContent=t.unregisteringSW;' +
    'var rs=await navigator.serviceWorker.getRegistrations();await Promise.all(rs.map(function(r){return r.unregister();}));' +
    'm.textContent=t.clearingCache;' +
    'var ks=await caches.keys();await Promise.all(ks.map(function(k){return caches.delete(k);}));' +
    'm.textContent=t.cleaningDB;' +
    'try{var dbs=await indexedDB.databases();for(var d of dbs){if(d.name&&d.name!=="CryptoKeys")indexedDB.deleteDatabase(d.name);}}catch(e2){try{indexedDB.deleteDatabase("AppDB");}catch(e3){}}' +
    'm.textContent=t.clearingStorage;localStorage.clear();' +
    'm.textContent=t.restoringData;for(var p of Object.entries(b)){localStorage.setItem(p[0],p[1]);}' +
    'sessionStorage.removeItem("__taproot_reset_backup__");' +
    's.innerHTML=' +
    '\'<div style="font-size:48px;margin-bottom:1rem">\\u2705</div>' +
    '<h2 style="margin-bottom:0.5rem">\'+t.resetComplete+\'</h2>' +
    '<p style="margin-bottom:0.5rem;color:#6b7280">\'+t.swUnregistered+\'</p>' +
    '<p style="margin-bottom:1rem;color:#059669;font-weight:600">\'+t.dataPreserved+\'</p>' +
    '<button onclick="location.href=\\\'/\\\'" style="padding:0.75rem 2rem;background:#10b981;color:white;border:none;border-radius:0.75rem;font-size:1rem;cursor:pointer">\'+t.openApp+\'</button>\';' +
    '}catch(e){' +
    's.innerHTML=' +
    '\'<div style="font-size:48px;margin-bottom:1rem">\\u26A0\\uFE0F</div>' +
    '<h2 style="margin-bottom:0.5rem">\'+t.resetFailed+\'</h2>' +
    '<p style="color:#dc2626;margin-bottom:0.5rem">\'+e.message+\'</p>' +
    '<p style="margin-top:1rem;color:#6b7280;font-size:0.875rem">\'+t.manualClear+\'</p>' +
    '<button onclick="location.reload()" style="padding:0.75rem 2rem;background:#6b7280;color:white;border:none;border-radius:0.75rem;font-size:1rem;cursor:pointer;margin-top:1rem">\'+t.retry+\'</button>\';' +
    '}})();' +
    '</script></body></html>';

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// ============================================================
// SPA Navigation Handler — Offline-first for PWA reliability
// ============================================================
async function handleNavigation() {
  const cachedIndex = await caches.match('/index.html');
  const cachedRoot = await caches.match('/');
  const shell = cachedIndex || cachedRoot;

  // Online: network-first index.html so deploys get shell matching latest /assets/*
  if (self.navigator.onLine) {
    try {
      const controller = new AbortController();
      const navConfig = activeConfig?.navTimeoutMs || {};
      const navTimeout = navConfig.withCache || DEFAULT_NAV_TIMEOUT_WITH_CACHE;
      const timeoutId = setTimeout(function () { controller.abort(); }, navTimeout);

      const networkResponse = await fetch('/index.html', {
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (networkResponse.ok) {
        const clean = stripRedirect(networkResponse);
        const cache = await caches.open(CACHE_NAME);
        await cache.put('/index.html', clean.clone());
        await cache.put('/', clean.clone());
        console.log('[SW] Serving fresh index.html (network-first navigation)');
        return clean;
      }
    } catch (error) {
      console.warn('[SW] Navigation network-first failed, falling back to cache:', error.message || error);
    }
  }

  if (shell) {
    console.log('[SW] Serving cached app shell');
    return stripRedirect(shell);
  }

  // 无本地 shell：首次访问或缓存已清空
  if (!self.navigator.onLine) {
    return createOfflineFallbackPage();
  }

  try {
    const controller = new AbortController();
    const navConfig = activeConfig?.navTimeoutMs || {};
    var navTimeout = navConfig.withoutCache || DEFAULT_NAV_TIMEOUT_WITHOUT_CACHE;
    var timeoutId = setTimeout(function () { controller.abort(); }, navTimeout);

    const networkResponse = await fetch('/index.html', {
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (networkResponse.ok) {
      const clean = stripRedirect(networkResponse);
      const cache = await caches.open(CACHE_NAME);
      cache.put('/index.html', clean.clone());
      cache.put('/', clean.clone());
      return clean;
    }
    throw new Error('HTTP ' + networkResponse.status);
  } catch (error) {
    console.warn('[SW] Navigation fetch failed (no shell):', error.message || error);
    return createOfflineFallbackPage();
  }
}

/**
 * Last-resort offline page — only shown when the app has NEVER been loaded before
 * (no cached index.html at all). This is an extreme edge case.
 */
function createOfflineFallbackPage() {
  return new Response(
    '<!DOCTYPE html><html' + dirAttr() + '><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Offline</title>' +
    '<style>*{margin:0;padding:0;box-sizing:border-box}body{display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,-apple-system,sans-serif;background:#f0fdf4;color:#065f46;text-align:center;padding:2rem}' +
    '.card{background:white;border-radius:1rem;padding:2rem;box-shadow:0 4px 20px rgba(0,0,0,0.08);max-width:320px;width:100%}' +
    '.icon{width:64px;height:64px;background:#d1fae5;border-radius:1rem;display:flex;align-items:center;justify-content:center;margin:0 auto 1rem}' +
    'h2{margin-bottom:0.5rem;color:#065f46}p{color:#6b7280;margin-bottom:1rem;font-size:0.875rem}' +
    'button{padding:0.75rem 1.5rem;background:#10b981;color:white;border:none;border-radius:0.75rem;cursor:pointer;font-size:0.875rem;width:100%}' +
    'button:active{background:#059669}</style></head>' +
    '<body><div class="card">' +
    '<div class="icon"><svg width="32" height="32" fill="none" stroke="#059669" stroke-width="2" viewBox="0 0 24 24"><path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.56 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/></svg></div>' +
    '<h2>' + swt('noNetwork') + '</h2>' +
    '<p>' + swt('noNetworkMsg') + '</p>' +
    '<button onclick="location.reload()">' + swt('retry') + '</button>' +
    '</div></body></html>',
    {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    }
  );
}

// ============================================================
// Cache-first: same-origin assets & CDN resources
// ============================================================
async function cacheFirstStrategy(request, cacheName, maxEntries) {
  // 1. Check cache
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    if (isValidCachedResponse(cachedResponse)) {
      return stripRedirect(cachedResponse);
    }
    console.warn('[SW] Corrupted cache entry evicted:', request.url);
    const cache = await caches.open(cacheName);
    cache.delete(request);
  }

  // 2. Fetch from network with configurable timeout
  try {
    const timeout = configVal('networkTimeoutMs', DEFAULT_NETWORK_TIMEOUT);
    const fetchController = new AbortController();
    const fetchTimeout = setTimeout(() => fetchController.abort(), timeout);
    const networkResponse = await fetch(request, { signal: fetchController.signal });
    clearTimeout(fetchTimeout);
    if (networkResponse.ok) {
      const clean = stripRedirect(networkResponse);
      const cache = await caches.open(cacheName);
      cache.put(request, clean.clone());
      trimCache(cacheName, maxEntries);
      return clean;
    }
    return networkResponse;
  } catch (error) {
    if (request.url.endsWith('.js') || request.url.endsWith('.tsx') || request.url.endsWith('.ts')) {
      return new Response('console.error("Offline - Resource not cached: ' + request.url + '");', {
        status: 503,
        headers: { 'Content-Type': 'application/javascript' }
      });
    }
    return new Response('Offline - Resource not cached', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// ============================================================
// Network-first: for paths overridden by remote config
// ============================================================
async function networkFirstStrategy(request, cacheName) {
  try {
    const timeout = configVal('networkTimeoutMs', DEFAULT_NETWORK_TIMEOUT);
    const fetchController = new AbortController();
    const fetchTimeout = setTimeout(() => fetchController.abort(), timeout);
    const networkResponse = await fetch(request, { signal: fetchController.signal });
    clearTimeout(fetchTimeout);

    if (networkResponse.ok) {
      const clean = stripRedirect(networkResponse);
      const cache = await caches.open(cacheName);
      cache.put(request, clean.clone());
      return clean;
    }
    throw new Error(`HTTP ${networkResponse.status}`);
  } catch (error) {
    // Fallback to cache
    const cachedResponse = await caches.match(request);
    if (cachedResponse && isValidCachedResponse(cachedResponse)) {
      console.log('[SW] Network-first fallback to cache:', request.url);
      return stripRedirect(cachedResponse);
    }
    return new Response('Offline - Resource not cached', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// ============================================================
// Cache-first for cross-origin images
// ============================================================
async function cacheFirstImageStrategy(request) {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    if (isValidCachedResponse(cachedResponse)) {
      return cachedResponse;
    }
    const cache = await caches.open(IMG_CACHE_NAME);
    cache.delete(request);
  }

  try {
    const networkResponse = await fetch(request);
    // img / CSS 背景等常为 no-cors → opaque（status 0, ok=false），仍应写入 Cache Storage
    if (networkResponse.ok || networkResponse.type === 'opaque') {
      try {
        const cache = await caches.open(IMG_CACHE_NAME);
        await cache.put(request, networkResponse.clone());
        const maxImg = configVal('maxImageCacheEntries', DEFAULT_MAX_IMG_CACHE_ENTRIES);
        trimCache(IMG_CACHE_NAME, maxImg);
      } catch (putErr) {
        console.warn('[SW] Image cache put failed:', request.url, putErr);
      }
      return networkResponse;
    }
    return networkResponse;
  } catch (error) {
    return createOfflineImageResponse();
  }
}

// ============================================================
// CACHE VALIDATION
// ============================================================
function isValidCachedResponse(response) {
  if (!response || response.status === 0) {
    return response && response.type === 'opaque' ? true : false;
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && parseInt(contentLength, 10) === 0) return false;
  if (response.type === 'error') return false;
  return true;
}

// ============================================================
// CACHE SIZE LIMITING
// ============================================================
async function trimCache(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= maxEntries) return;
    const toDelete = keys.length - maxEntries;
    console.log(`[SW] Trimming ${cacheName}: removing ${toDelete} oldest entries`);
    for (let i = 0; i < toDelete; i++) {
      await cache.delete(keys[i]);
    }
  } catch (err) {
    console.warn('[SW] Cache trim failed:', err);
  }
}

// ============================================================
// DAILY UPDATE CHECK - Background, non-blocking
// ============================================================
async function triggerDailyCheck() {
  try {
    const alreadyChecked = await hasCheckedThisPeriod();
    if (alreadyChecked) {
      console.log('[SW] Periodic check already done, skipping');
      return;
    }

    console.log('[SW] First open this period — checking server for updates...');
    await markCheckedThisPeriod();

    // 1. Check registration for new service-worker.js
    await self.registration.update();
    console.log('[SW] SW update check complete');

    // 2. Background refresh index.html
    try {
      const freshIndex = await fetch('/index.html', { cache: 'no-store' });
      if (freshIndex.ok) {
        const clean = stripRedirect(freshIndex);
        const cache = await caches.open(CACHE_NAME);
        await cache.put('/index.html', clean.clone());
        await cache.put('/', clean.clone());
        console.log('[SW] index.html refreshed in cache');
      }
    } catch {
      console.warn('[SW] Failed to refresh index.html, will retry next period');
    }

    // 3. Check remote config (this also applies config actions)
    await checkRemoteConfig();
  } catch (error) {
    console.warn('[SW] Periodic check failed (will retry):', error.message || error);
  }
}

// ============================================================
// MESSAGE HANDLER
// ============================================================
self.addEventListener('message', (event) => {
  const { type } = event.data || {};

  switch (type) {
    case 'SKIP_WAITING':
      console.log('[SW] Client approved update, calling skipWaiting()');
      self.skipWaiting();
      break;

    case 'GET_VERSION':
      event.ports[0]?.postMessage({
        version: CACHE_VERSION,
        cacheName: CACHE_NAME,
        remoteConfigUrl: REMOTE_CONFIG_URL,
        activeConfig: activeConfig
      });
      break;

    case 'CLEAR_CACHE':
      Promise.all([
        caches.delete(CACHE_NAME),
        caches.delete(IMG_CACHE_NAME),
        caches.delete(CDN_CACHE_NAME)
      ]).then(() => {
        event.ports[0]?.postMessage({ success: true });
      });
      break;

    case 'CHECK_UPDATE':
      self.registration.update().then(() => {
        event.ports[0]?.postMessage({ checked: true });
      }).catch((err) => {
        event.ports[0]?.postMessage({ checked: false, error: err.message });
      });
      break;

    case 'CHECK_REMOTE_CONFIG':
      checkRemoteConfig().then((result) => {
        event.ports[0]?.postMessage(result);
      }).catch((err) => {
        event.ports[0]?.postMessage({ hasUpdate: false, error: err.message });
      });
      break;

    case 'GET_REMOTE_CONFIG':
      // Client requests the current active config
      event.ports[0]?.postMessage({ config: activeConfig });
      break;

    case 'SET_LANGUAGE':
      const lang = event.data.lang;
      if (SW_TRANSLATIONS[lang]) {
        currentLang = lang;
        console.log('[SW] Language set to:', currentLang);
      } else {
        console.warn('[SW] Language not supported:', lang);
      }
      break;

    case 'PRECACHE_UPDATE':
      event.waitUntil(
        precacheUpdateShell()
          .then((result) => {
            event.ports[0]?.postMessage(result);
          })
          .catch((err) => {
            event.ports[0]?.postMessage({ ok: false, error: err?.message || String(err) });
          })
      );
      break;
  }
});

// ============================================================
// REMOTE CONFIG - Fetch, apply actions, notify clients
// ============================================================
async function checkRemoteConfig() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(REMOTE_CONFIG_URL, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[SW] Remote config fetch failed: HTTP ${response.status}`);
      return { hasUpdate: false, error: `HTTP ${response.status}` };
    }

    const config = await response.json();
    console.log('[SW] Remote config received:', config);

    // Persist to CacheStorage (SW-accessible)
    await saveCachedConfig(config);

    // ---- Execute remote config actions ----
    await applyRemoteConfigActions(config);

    // ---- Version check ----
    const remoteVersion = config.version || config.cacheVersion || config.appVersion;
    if (remoteVersion && remoteVersion !== CACHE_VERSION) {
      console.log(`[SW] Remote version ${remoteVersion} differs from local ${CACHE_VERSION}, update available`);
      self.registration.update().catch((err) => {
        console.warn('[SW] Auto update check failed:', err);
      });
      return { hasUpdate: true, remoteVersion, localVersion: CACHE_VERSION, config };
    }

    console.log(`[SW] Version up to date: ${CACHE_VERSION}`);
    return { hasUpdate: false, remoteVersion, localVersion: CACHE_VERSION, config };
  } catch (error) {
    console.warn('[SW] Remote config check failed:', error.message || error);
    return { hasUpdate: false, error: error.message || 'Network error' };
  }
}

// ============================================================
// APPLY REMOTE CONFIG ACTIONS
// ============================================================
async function applyRemoteConfigActions(config) {
  if (!config) return;

  // ---- Kill Switch ----
  // Nuclear option: unregister SW + purge all caches
  if (config.killSwitch === true) {
    console.warn('[SW] !! KILL SWITCH ACTIVATED !! Unregistering SW and purging all caches');
    const allCaches = await caches.keys();
    await Promise.all(allCaches.map((k) => caches.delete(k)));
    await self.registration.unregister();
    // Notify all clients to reload (they'll get raw server responses without SW)
    await broadcastToClients({ type: 'KILL_SWITCH', message: 'Service Worker has been deactivated by remote config.' });
    return; // Nothing else to do after kill switch
  }

  // ---- Purge All Caches ----
  if (config.purgeCache === true) {
    console.log('[SW] Remote config: purging ALL caches');
    await Promise.all([
      caches.delete(CACHE_NAME),
      caches.delete(IMG_CACHE_NAME),
      caches.delete(CDN_CACHE_NAME),
    ]);
    // Re-create main cache with app shell
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(APP_SHELL.map((url) => safeCacheAdd(cache, url)));
    // Re-save config to the fresh cache
    await saveCachedConfig(config);
    console.log('[SW] Cache purge complete, app shell re-cached');
  }

  // ---- Purge Image Cache Only ----
  if (config.purgeImageCache === true) {
    console.log('[SW] Remote config: purging image cache');
    await caches.delete(IMG_CACHE_NAME);
  }

  // ---- Force Update (skip rollout, activate waiting SW) ----
  if (config.forceUpdate === true) {
    console.log('[SW] Remote config: force update enabled');
    // If there's a waiting worker, skip waiting immediately
    const reg = self.registration;
    if (reg.waiting) {
      console.log('[SW] Force-activating waiting service worker');
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    // Also trigger an update check
    reg.update().catch(() => {});
  }

  // ---- Force Reload ----
  if (config.forceReload === true) {
    console.log('[SW] Remote config: force reload all clients');
    await broadcastToClients({ type: 'FORCE_RELOAD', reason: 'Remote config requested reload' });
  }

  // ---- Maintenance Mode ----
  // No action needed here — the fetch handler checks activeConfig.maintenance.enabled
  if (config.maintenance?.enabled) {
    console.log('[SW] Maintenance mode is ACTIVE:', config.maintenance.message || 'No message');
  }

  // ---- Notify clients about new config ----
  // Clients will read from localStorage (written by PWARegister.tsx)
  // SW also sends a message so clients can react immediately
  await broadcastToClients({
    type: 'REMOTE_CONFIG_UPDATED',
    config: config,
    version: CACHE_VERSION
  });
}

// ============================================================
// BROADCAST TO ALL CLIENTS
// ============================================================
async function broadcastToClients(message) {
  try {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      client.postMessage(message);
    }
    console.log(`[SW] Broadcast "${message.type}" to ${allClients.length} client(s)`);
  } catch (err) {
    console.warn('[SW] Broadcast failed:', err);
  }
}

// ============================================================
// PUSH NOTIFICATIONS
// ============================================================
self.addEventListener('push', (event) => {
  // Check if push notifications are enabled via feature flags
  if (activeConfig?.features?.push === false) {
    console.log('[SW] Push notifications disabled by remote config');
    return;
  }

  console.log('[SW] Push received');

  let payload = {
    title: (activeConfig?.appBranding?.appName) || 'App',
    body: swt('notification'),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'default',
    data: null,
  };

  if (event.data) {
    try {
      payload = Object.assign({}, payload, event.data.json());
    } catch (e) {
      console.error('[SW] Push data parse error:', e);
    }
  }

  const channelId = String(payload.channel_id || payload.channelId || '').trim();
  const nestedData = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const nestedUrl = nestedData.url && typeof nestedData.url === 'string' ? nestedData.url : '';
  const safePath = channelId
    ? '/home/community'
    : (nestedUrl.startsWith('/') ? nestedUrl : '/');
  const notificationData = Object.assign({}, nestedData, {
    url: safePath,
    channel_id: channelId,
  });

  event.waitUntil(
    self.registration.showNotification(String(payload.title || 'App'), {
      body: String(payload.body || swt('notification')),
      icon: String(payload.icon || '/icon-192.png'),
      badge: String(payload.badge || '/icon-192.png'),
      tag: String(payload.tag || 'default'),
      data: notificationData,
      image: payload.image,
      vibrate: payload.vibrate || [200, 100, 200],
      actions: payload.actions || [],
      requireInteraction: false,
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const urlToOpen = event.notification.data?.url
    || (event.action && { view: '/', reply: '/home/community', order: '/home/market', profile: '/home/profile' }[event.action])
    || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes(urlToOpen) && 'focus' in client) {
            return client.focus();
          }
        }
        return clients.openWindow(urlToOpen);
      })
  );
});

self.addEventListener('notificationclose', () => {});

// ============================================================
// BACKGROUND SYNC
// ============================================================
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-data') {
    event.waitUntil(syncData());
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'sync-data-periodic') {
    event.waitUntil(syncData());
  }
});

async function syncData() {
  console.log('[SW] Starting data sync...');
  try {
    const allClients = await self.clients.matchAll();
    if (allClients.length === 0) return;

    const syncQueue = await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => resolve(e.data);
      allClients[0].postMessage({ type: 'GET_SYNC_QUEUE' }, [channel.port2]);
      setTimeout(() => resolve([]), 1000);
    });

    if (!syncQueue || syncQueue.length === 0) return;

    const endpoints = {
      comment: '/api/comments',
      like: '/api/likes',
      purchase: '/api/purchases',
      post: '/api/posts',
      other: '/api/sync'
    };

    const results = await Promise.allSettled(
      syncQueue.map((item) =>
        fetch(endpoints[item.type] || endpoints.other, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.data)
        })
      )
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    console.log(`[SW] Sync complete: ${succeeded}/${syncQueue.length} succeeded`);
  } catch (error) {
    console.error('[SW] Sync error:', error);
    throw error;
  }
}

// ============================================================
// STARTUP - Load cached config into memory
// ============================================================
loadCachedConfig();

console.log(`[SW] Script loaded, version: ${CACHE_VERSION}`);
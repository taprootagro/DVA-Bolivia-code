// ============================================================================
// Utils Index - 统一导出工具函数
// ============================================================================

// Deep Merge
export { deepMerge, deepMergeAll, MERGE_REPLACE, MERGE_DEEP, MERGE_APPEND, MERGE_CONSERVATIVE } from './deepMerge';
export type { DeepMergeOptions, MergeStrategy } from './deepMerge';

// API Version
export {
  registerTransformer,
  getVersionFallbackChain,
  saveLastSuccessVersion,
  getLastSuccessVersion,
  getPreferredVersion,
  apiCallWithVersion,
  fetchConfigWithVersion,
  fetchConfigWithFallbackUrls,
} from './apiVersion';
export type {
  ApiVersion,
  ApiVersionInfo,
  ApiVersionResponse,
  VersionedRequest,
  VersionedResponse,
  ApiCallOptions,
} from './apiVersion';

// API Client
export { apiClient, apiGet, apiPost, clearCache, getCacheStats } from './apiClient';
export type { ApiClientOptions } from './apiClient';

export { languageToSpeechTag, speechTagFallbacks, ttsRateForLanguage } from './speechLocale';

// Capacitor Bridge — 原生能力统一封装（PWA / App 双模式自适应）
export { bridge, isNative, getPlatform, preloadVoices } from './capacitor-bridge';
export type { WebSpeechHoldSession } from './capacitor-bridge';
export {
  camera,
  geo,
  pushNotifications,
  filesystem,
  network,
  device,
  preferences,
  app,
  keyboard,
  statusBar,
  splashScreen,
  haptics,
  localNotifications,
  share,
  clipboard,
  dialog,
  toast,
  barcodeScanner,
  speechRecognition,
  textToSpeech,
  nativeAudio,
  screenOrientation,
  browser,
  actionSheet,
  keepAwake,
  fileOpener,
  contacts,
} from './capacitor-bridge';
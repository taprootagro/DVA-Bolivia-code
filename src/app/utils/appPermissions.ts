/**
 * 应用权限：首次引导、设置页管理、AI 定位上下文。
 * 系统权限无法在 Web 内撤销；appPref 开关控制本 App 是否调用对应能力。
 */

import { camera, geo, isNative, app as capApp } from './capacitor-bridge';
import { cameraManager } from './cameraManager';

export const FIRST_LAUNCH_KEY = '__taproot_permissions_intro_v1__';

const PREF_KEYS = {
  camera: '__taproot_pref_camera__',
  microphone: '__taproot_pref_mic__',
  location: '__taproot_pref_location__',
} as const;

export type PermissionKind = 'camera' | 'microphone' | 'location';
export type PermissionOsState = 'granted' | 'denied' | 'prompt' | 'unsupported';

export type LocationContextForAI = {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  capturedAt: number;
};

export type PermissionSnapshot = {
  kind: PermissionKind;
  os: PermissionOsState;
  appEnabled: boolean;
};

const APP_PREF_EVENT = 'taproot-app-pref-changed';

function readPref(key: string, defaultVal = true): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return defaultVal;
    return v === '1';
  } catch {
    return defaultVal;
  }
}

function writePref(key: string, enabled: boolean): void {
  try {
    localStorage.setItem(key, enabled ? '1' : '0');
    window.dispatchEvent(new CustomEvent(APP_PREF_EVENT));
  } catch {
    /* ignore */
  }
}

export function isAppPermissionEnabled(kind: PermissionKind): boolean {
  switch (kind) {
    case 'camera':
      return readPref(PREF_KEYS.camera);
    case 'microphone':
      return readPref(PREF_KEYS.microphone);
    case 'location':
      return readPref(PREF_KEYS.location);
    default:
      return true;
  }
}

export function setAppPermissionEnabled(kind: PermissionKind, enabled: boolean): void {
  switch (kind) {
    case 'camera':
      writePref(PREF_KEYS.camera, enabled);
      break;
    case 'microphone':
      writePref(PREF_KEYS.microphone, enabled);
      break;
    case 'location':
      writePref(PREF_KEYS.location, enabled);
      break;
  }
}

export function hasCompletedFirstLaunchPermissionIntro(): boolean {
  try {
    return localStorage.getItem(FIRST_LAUNCH_KEY) === '1';
  } catch {
    return false;
  }
}

export function markFirstLaunchPermissionIntroDone(): void {
  try {
    localStorage.setItem(FIRST_LAUNCH_KEY, '1');
  } catch {
    /* ignore */
  }
}

function mapCapPermissionState(
  state: string | undefined,
): PermissionOsState {
  if (state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  if (state === 'prompt') return 'prompt';
  return 'unsupported';
}

async function queryWebPermission(name: string): Promise<PermissionOsState> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) {
    return 'prompt';
  }
  try {
    const status = await navigator.permissions.query({ name } as PermissionDescriptor);
    return mapCapPermissionState(status.state);
  } catch {
    return 'prompt';
  }
}

async function queryGeoOsState(): Promise<PermissionOsState> {
  try {
    return await geo.checkPermissions();
  } catch {
    return 'prompt';
  }
}

export async function queryPermission(kind: PermissionKind): Promise<PermissionOsState> {
  switch (kind) {
    case 'camera':
      try {
        return await camera.checkPermissions();
      } catch {
        return 'prompt';
      }
    case 'microphone':
      return queryWebPermission('microphone');
    case 'location':
      return queryGeoOsState();
    default:
      return 'unsupported';
  }
}

async function requestCameraOs(): Promise<PermissionOsState> {
  if (!isAppPermissionEnabled('camera')) return 'denied';
  try {
    const managed = await cameraManager.acquire('environment');
    cameraManager.release();
    return managed ? 'granted' : 'prompt';
  } catch {
    return await queryPermission('camera');
  }
}

async function requestMicrophoneOs(): Promise<PermissionOsState> {
  if (!isAppPermissionEnabled('microphone')) return 'denied';
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name ?? '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'denied';
    return 'prompt';
  }
}

async function requestLocationOs(): Promise<PermissionOsState> {
  if (!isAppPermissionEnabled('location')) return 'denied';
  try {
    const state = await geo.requestPermissions();
    if (state === 'granted') return 'granted';
  } catch {
    /* fall through */
  }
  return queryGeoOsState();
}

/** 申请系统权限（已 granted 则跳过） */
export async function requestPermission(kind: PermissionKind): Promise<PermissionOsState> {
  const current = await queryPermission(kind);
  if (current === 'granted') return 'granted';
  if (!isAppPermissionEnabled(kind)) return 'denied';

  switch (kind) {
    case 'camera':
      return requestCameraOs();
    case 'microphone':
      return requestMicrophoneOs();
    case 'location':
      return requestLocationOs();
    default:
      return 'unsupported';
  }
}

export async function queryAllPermissions(): Promise<PermissionSnapshot[]> {
  const kinds: PermissionKind[] = ['camera', 'microphone', 'location'];
  const snapshots: PermissionSnapshot[] = [];
  for (const kind of kinds) {
    const os = await queryPermission(kind);
    snapshots.push({
      kind,
      os,
      appEnabled: isAppPermissionEnabled(kind),
    });
  }
  return snapshots;
}

export async function allCorePermissionsGranted(): Promise<boolean> {
  const snaps = await queryAllPermissions();
  return snaps.every((s) => s.os === 'granted');
}

/** 顺序申请相机 → 麦克风 → 定位（仅未 granted 且 app 开关开启） */
export async function requestAllPendingPermissions(): Promise<void> {
  const order: PermissionKind[] = ['camera', 'microphone', 'location'];
  for (const kind of order) {
    const os = await queryPermission(kind);
    if (os !== 'granted' && isAppPermissionEnabled(kind)) {
      await requestPermission(kind);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

export type FirstLaunchFlowResult =
  | { action: 'skip_already_done' }
  | { action: 'skip_all_granted' }
  | { action: 'show_intro' };

/** 判断是否需展示首次引导弹层 */
export async function evaluateFirstLaunchPermissionFlow(): Promise<FirstLaunchFlowResult> {
  if (hasCompletedFirstLaunchPermissionIntro()) {
    return { action: 'skip_already_done' };
  }
  if (await allCorePermissionsGranted()) {
    markFirstLaunchPermissionIntroDone();
    return { action: 'skip_all_granted' };
  }
  return { action: 'show_intro' };
}

let cachedLocation: LocationContextForAI | null = null;
let cachedLocationAt = 0;
const LOCATION_CACHE_MS = 5 * 60 * 1000;

/** Round GPS to 2 decimal places (~1.1 km) before sending to AI. */
export function blurGpsCoordinate(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 可选 GPS 上下文：未授权 / 应用内关闭 / 获取失败时返回 null，不抛错、不弹系统框。
 * AI 分析、追问、语音等必须照常进行，仅在有坐标时附带 locationContext。
 */
export async function getLocationForAI(): Promise<LocationContextForAI | null> {
  try {
    if (!isAppPermissionEnabled('location')) return null;

    const os = await queryPermission('location');
    // 未 granted 时不调用 getCurrentPosition，避免 AI 请求前长时间等待或弹出定位授权
    if (os !== 'granted') return null;

    const now = Date.now();
    if (cachedLocation && now - cachedLocationAt < LOCATION_CACHE_MS) {
      return cachedLocation;
    }

    const pos = await geo.getCurrentPosition({
      enableHighAccuracy: false,
      timeout: 3000,
      maximumAge: LOCATION_CACHE_MS,
    });
    if (!pos) return null;

    cachedLocation = {
      latitude: blurGpsCoordinate(pos.latitude),
      longitude: blurGpsCoordinate(pos.longitude),
      accuracyMeters: pos.accuracy,
      capturedAt: pos.timestamp || now,
    };
    cachedLocationAt = now;
    return cachedLocation;
  } catch {
    return null;
  }
}

export function clearLocationCache(): void {
  cachedLocation = null;
  cachedLocationAt = 0;
}

export type OpenSystemSettingsResult = 'opened' | 'web_hint';

/** 跳转系统设置（Native）或返回 Web 提示 */
export async function openSystemPermissionSettings(): Promise<OpenSystemSettingsResult> {
  return capApp.openSystemSettings();
}

export function subscribeAppPrefChanges(handler: () => void): () => void {
  const fn = () => handler();
  window.addEventListener(APP_PREF_EVENT, fn);
  return () => window.removeEventListener(APP_PREF_EVENT, fn);
}

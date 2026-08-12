import { storageGetJSON, storageRemove, storageSetJSON } from "./safeStorage";

const KEY = "__taproot_profile_edit_saved_at__";

interface Payload {
  at: number;
}

/** 距离允许再次编辑还剩多少毫秒；0 表示不限 / 已过期 / 未记录 */
export function getProfileEditCooldownRemainingMs(cooldownSeconds: number): number {
  if (cooldownSeconds <= 0) return 0;
  const raw = storageGetJSON<Payload>(KEY);
  const at = raw?.at;
  if (typeof at !== "number" || !Number.isFinite(at)) return 0;
  const end = at + cooldownSeconds * 1000;
  return Math.max(0, end - Date.now());
}

export function recordProfileEditCooldownSave(): void {
  storageSetJSON(KEY, { at: Date.now() });
}

export function clearProfileEditCooldown(): void {
  storageRemove(KEY);
}

export function formatProfileEditCooldownMessage(
  template: string,
  remainingMs: number,
): string {
  const sec = Math.max(1, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return template
    .replace(/\{minutes\}/g, String(minutes))
    .replace(/\{seconds\}/g, String(seconds));
}

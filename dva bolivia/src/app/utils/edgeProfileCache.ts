import { EDGE_PROFILE_CACHE_KEY } from "../constants";
import { storageGetJSON, storageRemove, storageSetJSON } from "./safeStorage";

export type EdgeProfileCachePayload = {
  userId: string;
  contentSuperAdmin: boolean;
  contentRole: string;
  appRole: "farmer" | "distributor";
  profileCompleted: boolean;
  displayName: string;
  phone: string;
  pickupAddress: string;
  avatarUrl: string;
  dbProfile: Record<string, unknown> | null;
  savedAt: number;
};

export function readEdgeProfileCache(): EdgeProfileCachePayload | null {
  const raw = storageGetJSON<EdgeProfileCachePayload>(
    EDGE_PROFILE_CACHE_KEY,
    null,
  );
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.userId !== "string" || !raw.userId) return null;
  return raw;
}

export function writeEdgeProfileCache(payload: EdgeProfileCachePayload): void {
  storageSetJSON(EDGE_PROFILE_CACHE_KEY, payload);
}

export function clearEdgeProfileCache(): void {
  storageRemove(EDGE_PROFILE_CACHE_KEY);
}

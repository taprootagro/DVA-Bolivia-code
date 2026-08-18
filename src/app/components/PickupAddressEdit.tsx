import { useState, useEffect, useRef, useCallback } from "react";
import { SecondaryView } from "./SecondaryView";
import { useLanguage } from "../hooks/useLanguage";
import { kvPutEncrypted } from "../utils/db";
import { storageSet } from "../utils/safeStorage";
import { getSessionAccessTokenForEdge, isServerAssignedId } from "../utils/auth";
import { storageGetJSON } from "../utils/safeStorage";
import { CONFIG_STORAGE_KEY } from "../constants";
import { defaultConfig } from "/taprootagrosetting";
import type { HomePageConfig } from "../hooks/useHomeConfig";
import { deepMerge, MERGE_REPLACE } from "../utils";

const PICKUP_MAX = 200;
const LOCAL_SAVE_DEBOUNCE_MS = 500;

interface PickupAddressEditProps {
  onClose: () => void;
  initialAddress?: string;
  onSave?: (address: string) => void;
  /** Edge GET /profile 刷新（写入 pickup_address 后） */
  onRemoteSynced?: () => void;
}

function mergedHomeConfig(): HomePageConfig {
  const parsed = storageGetJSON<HomePageConfig>(CONFIG_STORAGE_KEY);
  if (parsed) return deepMerge(defaultConfig as unknown as Record<string, unknown>, parsed as unknown as Record<string, unknown>, MERGE_REPLACE) as unknown as HomePageConfig;
  return defaultConfig;
}

async function postPickupOnly(pickupAddress: string): Promise<boolean> {
  if (!isServerAssignedId()) return false;
  const token = await getSessionAccessTokenForEdge();
  if (!token) return false;
  const cfg = mergedHomeConfig();
  const b = cfg.backendProxyConfig;
  const base = String(b?.supabaseUrl || "").trim();
  const anon = String(b?.supabaseAnonKey || "").trim();
  if (
    !base ||
    base.includes("your-") ||
    !anon ||
    b?.enabled === false
  ) {
    return false;
  }
  const url = `${base.replace(/\/$/, "")}/functions/v1/${(b?.edgeFunctionName || "server").replace(/^\//, "")}/profile`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(anon ? { apikey: anon } : {}),
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        pickupAddress: pickupAddress.slice(0, PICKUP_MAX),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function clipPickup(value: string): string {
  return value.slice(0, PICKUP_MAX);
}

function persistPickupLocally(address: string): void {
  kvPutEncrypted("pickup-address", address).catch(() => {});
  storageSet("pickup-address", address);
}

export function PickupAddressEdit({
  onClose,
  initialAddress = "",
  onSave,
  onRemoteSynced,
}: PickupAddressEditProps) {
  const { t } = useLanguage();
  const [address, setAddress] = useState(() => clipPickup(initialAddress));
  /** 用户正在编辑时不把父级 refresh 的结果写回 textarea，避免中途 autosync 覆盖输入 */
  const isDirtyRef = useRef(false);
  const addressRef = useRef(clipPickup(initialAddress));
  const lastLocalSaved = useRef(clipPickup(initialAddress));
  const lastRemoteSaved = useRef(clipPickup(initialAddress));
  const localTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closingRef = useRef(false);

  addressRef.current = address;

  useEffect(() => {
    if (isDirtyRef.current) return;
    const clipped = clipPickup(initialAddress);
    setAddress(clipped);
    addressRef.current = clipped;
    lastLocalSaved.current = clipped;
    lastRemoteSaved.current = clipped;
  }, [initialAddress]);

  useEffect(() => {
    if (!isDirtyRef.current) return;
    if (localTimerRef.current) clearTimeout(localTimerRef.current);
    localTimerRef.current = setTimeout(() => {
      localTimerRef.current = null;
      const next = addressRef.current;
      if (next === lastLocalSaved.current) return;
      lastLocalSaved.current = next;
      persistPickupLocally(next);
      onSave?.(next);
    }, LOCAL_SAVE_DEBOUNCE_MS);

    return () => {
      if (localTimerRef.current) {
        clearTimeout(localTimerRef.current);
        localTimerRef.current = null;
      }
    };
  }, [address, onSave]);

  const flushLocal = useCallback(() => {
    if (localTimerRef.current) {
      clearTimeout(localTimerRef.current);
      localTimerRef.current = null;
    }
    const next = addressRef.current;
    if (next === lastLocalSaved.current) return;
    lastLocalSaved.current = next;
    persistPickupLocally(next);
    onSave?.(next);
  }, [onSave]);

  const flushRemote = useCallback(async (): Promise<boolean> => {
    flushLocal();
    const next = addressRef.current;
    if (next === lastRemoteSaved.current) return true;
    const ok = await postPickupOnly(next);
    if (ok) {
      lastRemoteSaved.current = next;
      onRemoteSynced?.();
    }
    return ok;
  }, [flushLocal, onRemoteSynced]);

  useEffect(() => {
    return () => {
      if (closingRef.current) return;
      flushLocal();
      const next = addressRef.current;
      if (next !== lastRemoteSaved.current) {
        void postPickupOnly(next).then((ok) => {
          if (ok) onRemoteSynced?.();
        });
      }
    };
  }, [flushLocal, onRemoteSynced]);

  const handleClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    void (async () => {
      await flushRemote();
      onClose();
    })();
  }, [flushRemote, onClose]);

  return (
    <SecondaryView onClose={handleClose} title={t.profile.pickupInfo} showTitle={true}>
      <div className="p-4 h-full flex flex-col min-h-[200px]">
        <textarea
          value={address}
          onChange={(e) => {
            isDirtyRef.current = true;
            setAddress(clipPickup(e.target.value));
          }}
          maxLength={PICKUP_MAX}
          placeholder=""
          className="w-full flex-1 min-h-[160px] text-sm text-gray-800 outline-none resize-none placeholder:text-gray-400 p-4 border border-gray-100 rounded-xl"
          autoFocus
        />
        <p className="text-[10px] text-gray-400 mt-2 px-1">
          {t.profile.pickupAddressLimit?.replace("{n}", String(PICKUP_MAX)) ||
            `Max ${PICKUP_MAX} characters.`}
        </p>
      </div>
    </SecondaryView>
  );
}

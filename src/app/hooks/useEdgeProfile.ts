import { useState, useEffect, useCallback, useRef } from "react";
import {
  isUserLoggedIn,
  isServerAssignedId,
  getSessionAccessTokenForEdge,
  getServerUserId,
  syncAccessTokenFromSupabaseSession,
  TAPROOT_AUTH_CHANGE_EVENT,
} from "../utils/auth";
import { storageGetJSON } from "../utils/safeStorage";
import { CONFIG_STORAGE_KEY } from "../constants";
import { defaultConfig } from "/taprootagrosetting";
import { deepMerge, MERGE_REPLACE } from "../utils";
import type { HomePageConfig } from "./useHomeConfig";
import { applyServerProfilePayloadToLocalConfig } from "../utils/supabaseBrowser";
import {
  readContentSuperAdminCache,
  writeContentSuperAdminCache,
  clearContentSuperAdminCache,
} from "../utils/contentSuperAdminCache";
import {
  readEdgeProfileCache,
  writeEdgeProfileCache,
  clearEdgeProfileCache,
} from "../utils/edgeProfileCache";

export type AppRole = "farmer" | "distributor";
export type ContentRole = 'none' | 'editor' | 'admin';

export type RefreshProfileOptions = {
  /** Keep cached UI visible; do not set loading=true */
  background?: boolean;
};

const PROFILE_FOREGROUND_REFRESH_MIN_MS = 60_000;
let lastProfilePullAt = 0;

function mergedHomeConfig(): HomePageConfig {
  const parsed = storageGetJSON<HomePageConfig>(CONFIG_STORAGE_KEY);
  if (parsed) return deepMerge(defaultConfig, parsed, MERGE_REPLACE);
  return defaultConfig;
}

function parseAppRole(raw: unknown): AppRole {
  return raw === "distributor" ? "distributor" : "farmer";
}

/**
 * Edge GET /profile — app_role、资料列、profile JSON（扩展字段）。
 */
function parseDbProfile(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function initialContentSuperAdminAndLoading(): {
  contentSuperAdmin: boolean;
  contentRole: ContentRole;
  loading: boolean;
} {
  if (!isUserLoggedIn() || !isServerAssignedId()) {
    return { contentSuperAdmin: false, contentRole: "none", loading: false };
  }
  const uid = getServerUserId();
  if (!uid) {
    return { contentSuperAdmin: false, contentRole: "none", loading: true };
  }
  const cached = readContentSuperAdminCache();
  if (cached && cached.userId === uid) {
    const role = (cached.contentRole as ContentRole) || "none";
    return { contentSuperAdmin: role === "admin", contentRole: role, loading: false };
  }
  return { contentSuperAdmin: false, contentRole: "none", loading: true };
}

type InitialEdgeState = {
  contentSuperAdmin: boolean;
  contentRole: ContentRole;
  appRole: AppRole;
  dbProfile: Record<string, unknown> | null;
  profileCompleted: boolean;
  displayName: string;
  phone: string;
  pickupAddress: string;
  avatarUrl: string;
  loading: boolean;
};

function initialEdgeProfileHookState(): InitialEdgeState {
  const empty: InitialEdgeState = {
    contentSuperAdmin: false,
    contentRole: "none",
    appRole: "farmer",
    dbProfile: null,
    profileCompleted: false,
    displayName: "",
    phone: "",
    pickupAddress: "",
    avatarUrl: "",
    loading: false,
  };
  if (!isUserLoggedIn() || !isServerAssignedId()) {
    return empty;
  }
  const uid = getServerUserId();
  if (!uid) {
    return { ...empty, loading: true };
  }
  const edge = readEdgeProfileCache();
  if (edge && edge.userId === uid) {
    return {
      contentSuperAdmin: edge.contentSuperAdmin === true,
      contentRole: (edge.contentRole as ContentRole) || (edge.contentSuperAdmin ? "admin" : "none"),
      appRole: edge.appRole === "distributor" ? "distributor" : "farmer",
      dbProfile: edge.dbProfile,
      profileCompleted: edge.profileCompleted === true,
      displayName: typeof edge.displayName === "string" ? edge.displayName : "",
      phone: typeof edge.phone === "string" ? edge.phone : "",
      pickupAddress:
        typeof edge.pickupAddress === "string" ? edge.pickupAddress : "",
      avatarUrl: typeof edge.avatarUrl === "string" ? edge.avatarUrl : "",
      loading: false,
    };
  }
  const csa = initialContentSuperAdminAndLoading();
  return {
    ...empty,
    contentSuperAdmin: csa.contentSuperAdmin,
    contentRole: csa.contentRole,
    loading: csa.loading,
  };
}

export function useEdgeProfile() {
  const init = initialEdgeProfileHookState();
  const [contentSuperAdmin, setContentSuperAdmin] = useState(init.contentSuperAdmin);
  const [contentRole, setContentRole] = useState<ContentRole>(init.contentRole);
  const [appRole, setAppRole] = useState<AppRole>(init.appRole);
  const [dbProfile, setDbProfile] = useState<Record<string, unknown> | null>(
    init.dbProfile,
  );
  const [profileCompleted, setProfileCompleted] = useState(init.profileCompleted);
  const [displayName, setDisplayName] = useState(init.displayName);
  const [phone, setPhone] = useState(init.phone);
  const [pickupAddress, setPickupAddress] = useState(init.pickupAddress);
  const [avatarUrl, setAvatarUrl] = useState(init.avatarUrl);
  const [loading, setLoading] = useState(init.loading);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlightRef = useRef(false);

  const refresh = useCallback(async (options?: RefreshProfileOptions) => {
    const background = options?.background === true;
    const uidEarly = getServerUserId();
    const hasCachedProfile =
      !!uidEarly && readEdgeProfileCache()?.userId === uidEarly;

    if (!isUserLoggedIn() || !isServerAssignedId()) {
      clearContentSuperAdminCache();
      clearEdgeProfileCache();
      setContentSuperAdmin(false);
      setContentRole("none");
      setAppRole("farmer");
      setDbProfile(null);
      setProfileCompleted(false);
      setDisplayName("");
      setPhone("");
      setPickupAddress("");
      setAvatarUrl("");
      setLoading(false);
      setError(null);
      return;
    }

    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;

    if (!background && !hasCachedProfile) {
      setLoading(true);
    }
    if (!background) {
      setError(null);
    }

    try {
      const cfg = mergedHomeConfig();
      const b = cfg.backendProxyConfig;
      const url = (b?.supabaseUrl || "").trim().replace(/\/+$/, "");
      const anon = (b?.supabaseAnonKey || "").trim();
      const fn = (b?.edgeFunctionName || "server").replace(/^\//, "");
      let token = await getSessionAccessTokenForEdge();
      const uid = getServerUserId();
      if (!token && isUserLoggedIn() && isServerAssignedId()) {
        await syncAccessTokenFromSupabaseSession();
        token = await getSessionAccessTokenForEdge();
      }
      if (!url || url.includes("your-") || !anon) {
        clearContentSuperAdminCache();
        clearEdgeProfileCache();
        setContentSuperAdmin(false);
        setContentRole("none");
        setAppRole("farmer");
        setDbProfile(null);
        setProfileCompleted(false);
        setDisplayName("");
        setPhone("");
        setPickupAddress("");
        setAvatarUrl("");
        setLoading(false);
        setError(null);
        return;
      }
      if (!token) {
        if (isUserLoggedIn() && isServerAssignedId()) {
          if (!background) setLoading(true);
          setError(null);
          return;
        }
        clearContentSuperAdminCache();
        clearEdgeProfileCache();
        setContentSuperAdmin(false);
        setContentRole("none");
        setAppRole("farmer");
        setDbProfile(null);
        setProfileCompleted(false);
        setDisplayName("");
        setPhone("");
        setPickupAddress("");
        setAvatarUrl("");
        setLoading(false);
        setError(null);
        return;
      }

      const profileUrl = `${url}/functions/v1/${fn}/profile`;
      const headersFor = (t: string) => ({
        "Content-Type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${t}`,
      });
      let res = await fetch(profileUrl, {
        method: "GET",
        headers: headersFor(token),
        cache: "no-store",
      });
      if (!res.ok && (res.status === 401 || res.status === 403)) {
        await syncAccessTokenFromSupabaseSession();
        const token2 = await getSessionAccessTokenForEdge();
        if (token2) {
          res = await fetch(profileUrl, {
            method: "GET",
            headers: headersFor(token2),
            cache: "no-store",
          });
        }
      }
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          clearContentSuperAdminCache();
          clearEdgeProfileCache();
          setContentSuperAdmin(false);
          setContentRole("none");
        }
        setError(`HTTP ${res.status}`);
        return;
      }
      lastProfilePullAt = Date.now();
      const data = (await res.json()) as Record<string, unknown>;
      const newContentRole = (typeof data.contentRole === "string" && (data.contentRole === "admin" || data.contentRole === "editor"))
        ? data.contentRole as ContentRole
        : "none";
      const isAdmin = newContentRole === "admin";
      if ((isAdmin || newContentRole === "editor") && uid) {
        writeContentSuperAdminCache(uid, newContentRole);
      } else {
        clearContentSuperAdminCache();
      }
      const role = parseAppRole(data.appRole);
      const parsedProfile = parseDbProfile(data.profile);
      setContentSuperAdmin(isAdmin);
      setContentRole(newContentRole);
      setAppRole(role);
      setDbProfile(parsedProfile);
      setProfileCompleted(data.profileCompleted === true);
      const dn = typeof data.displayName === "string" ? data.displayName : "";
      const ph = typeof data.phone === "string" ? data.phone : "";
      const pu = typeof data.pickupAddress === "string" ? data.pickupAddress : "";
      const av = typeof data.avatarUrl === "string" ? data.avatarUrl : "";
      setDisplayName(dn);
      setPhone(ph);
      setPickupAddress(pu);
      setAvatarUrl(av);
      if (uid) {
        writeEdgeProfileCache({
          userId: uid,
          contentSuperAdmin: isAdmin,
          contentRole: newContentRole,
          appRole: role,
          profileCompleted: data.profileCompleted === true,
          displayName: dn,
          phone: ph,
          pickupAddress: pu,
          avatarUrl: av,
          dbProfile: parsedProfile,
          savedAt: Date.now(),
        });
      }
      applyServerProfilePayloadToLocalConfig(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      refreshInFlightRef.current = false;
      if (!background) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const onAuthChanged = () => {
      void refresh();
    };
    window.addEventListener(TAPROOT_AUTH_CHANGE_EVENT, onAuthChanged);
    return () =>
      window.removeEventListener(TAPROOT_AUTH_CHANGE_EVENT, onAuthChanged);
  }, [refresh]);

  /** 有缓存则 stale-while-revalidate；无缓存则前台拉一次 */
  useEffect(() => {
    if (!isUserLoggedIn() || !isServerAssignedId()) return;
    const uid = getServerUserId();
    if (!uid) {
      void refresh();
      return;
    }
    const edge = readEdgeProfileCache();
    if (edge?.userId === uid) {
      void refresh({ background: true });
      return;
    }
    void refresh();
  }, [refresh]);

  /** 回前台 / bfcache：TTL 内后台刷新 app_role（CMS 改角色后可自动更新） */
  useEffect(() => {
    const handleForeground = () => {
      if (document.visibilityState !== "visible") return;
      if (!isUserLoggedIn() || !isServerAssignedId()) return;
      const now = Date.now();
      if (
        lastProfilePullAt > 0 &&
        now - lastProfilePullAt < PROFILE_FOREGROUND_REFRESH_MIN_MS
      ) {
        return;
      }
      void refresh({ background: true });
    };
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      handleForeground();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pageshow", handleForeground);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pageshow", handleForeground);
    };
  }, [refresh]);

  return {
    contentSuperAdmin,
    contentRole,
    appRole,
    dbProfile,
    profileCompleted,
    displayName,
    phone,
    pickupAddress,
    avatarUrl,
    loading,
    error,
    refresh,
  };
}

import type { HomePageConfig } from "../../hooks/useHomeConfig";
import type { createCmsTranslator } from "../../i18n/cmsTranslate";

/**
 * Shallow-merge `partial` into `config[key]` and return a new config; all other fields are kept.
 * A key patched to `undefined` is removed so "leave empty = built-in default" fields disappear
 * from the saved JSON instead of lingering as explicit values.
 */
export function patchConfigSection<K extends keyof HomePageConfig>(
  config: HomePageConfig,
  key: K,
  partial: Partial<HomePageConfig[K]>,
): HomePageConfig {
  const next: Record<string, unknown> = { ...((config[key] ?? {}) as object), ...partial };
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined) delete next[k];
  }
  return { ...config, [key]: next };
}

/** Seed for patches when workingConfig has no backendProxyConfig yet. */
export function emptyBackendProxyShell(): NonNullable<HomePageConfig["backendProxyConfig"]> {
  return {
    supabaseUrl: "",
    supabaseAnonKey: "",
    enabled: false,
    chatProvider: "supabase",
    imMode: "im-provider-direct",
    cmsStorageProvider: "supabase",
    mediaCdnBaseUrl: "",
  };
}

export type PatchSection = <K extends keyof HomePageConfig>(
  key: K,
  partial: Partial<HomePageConfig[K]>,
) => void;

export type CmsT = ReturnType<typeof createCmsTranslator>;

export type CmsTabProps = {
  workingConfig: HomePageConfig;
  patchSection: PatchSection;
  ct: CmsT;
};

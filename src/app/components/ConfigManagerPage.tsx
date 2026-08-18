import { useNavigate } from "react-router";
import React, { useState, useEffect, useRef } from "react";
import { useConfigContext } from "../hooks/ConfigProvider";
import { useContentSuperAdmin } from "../hooks/useContentSuperAdmin";
import type { CmsStorageProvider, HomePageConfig } from "../hooks/useHomeConfig";
import { CONFIG_STORAGE_KEY } from "../constants";
import { storageGetJSON } from "../utils/safeStorage";
import { pauseConfigRemotePull, resumeConfigRemotePull } from "../utils/configRemotePullPause";
import { useLanguage } from "../hooks/useLanguage";
import { createCmsTranslator } from "../i18n/cmsTranslate";
import enTranslations from "../i18n/lang/en";
import { ArrowLeft, Plus, Trash2, Save, Edit3, RotateCcw, ChevronDown, ChevronRight, Shield, X, Menu, RefreshCw, Cloud, CloudOff, CloudUpload, AlertTriangle, CheckCircle2, Loader2, Eye, Download } from "lucide-react";
import readXlsxFile from "read-excel-file";
import { RichTextEditor } from "./RichTextEditor";
import {
  testConnection as supabaseTestConnection,
  isSupabaseConfigured,
  type TestConnectionResult,
} from "../services/ConfigSyncService";
import { CmsStorageUploadRow } from "./CmsStorageUploadRow";
import { CmsMediaImg } from "./CmsMediaImg";
import { CmsVideoUrlEmbedPreview } from "./CmsVideoUrlEmbedPreview";
import { renderPwaIconsFromImageFile } from "../utils/pwaAppIconRender";
import { uploadFileToCmsPublic } from "../utils/cmsPublicUpload";
import { ensureEdgeSessionReady } from "../utils/auth";
import { isDeveloperMode } from "../utils/developerMode";
import SortableList from "./SortableList";

const MAX_PWA_SOURCE_IMAGE_BYTES = 15 * 1024 * 1024;

/** Filled when pasting into workingConfig if backendProxy missing */
function emptyBackendProxyShell(): NonNullable<HomePageConfig["backendProxyConfig"]> {
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

function PwaIconInstallPreview({
  icon192Url,
  icon512Url,
  ct,
}: {
  icon192Url?: string;
  icon512Url?: string;
  ct: (keyOrZh: string, enOrZh?: string, en?: string) => string;
}) {
  const wrap =
    "flex items-center justify-center overflow-hidden border border-gray-200 bg-gray-50 shadow-sm";
  const radius = "rounded-[22%]";
  const cell = "flex flex-col items-center gap-1";
  const only192 = !!(icon192Url && !icon512Url);
  const only512 = !!(icon512Url && !icon192Url);
  return (
    <div className="pt-2 border-t border-gray-100 space-y-2">
      <p className="text-xs text-gray-500">
        {ct("messages.preview_rounded_like_app_icon", "图标预览（圆角接近安装图标）", "Preview (rounded like app icon)")}
      </p>
      {only192 && (
        <p className="text-[10px] text-amber-600">
          {ct("messages.m_512_512_missing_add_it_for_crisp_launcher", "尚未设置 512×512，建议补全以兼容高清启动图标。", "512×512 missing; add it for crisp launcher icons.")}
        </p>
      )}
      {only512 && (
        <p className="text-[10px] text-amber-600">
          {ct("messages.m_192_192_missing_add_it_for_standard_pwa", "尚未设置 192×192，建议补全以兼容标准 PWA 图标。", "192×192 missing; add it for standard PWA icons.")}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-4">
        {icon192Url ? (
          <div className={cell}>
            <div className={`${wrap} ${radius} w-12 h-12`}>
              <CmsMediaImg src={icon192Url} alt="" className="w-full h-full object-cover" />
            </div>
            <span className="text-[10px] text-gray-400">192</span>
          </div>
        ) : null}
        {icon512Url ? (
          <div className={cell}>
            <div className={`${wrap} ${radius} w-16 h-16`}>
              <CmsMediaImg src={icon512Url} alt="" className="w-full h-full object-cover" />
            </div>
            <span className="text-[10px] text-gray-400">512</span>
          </div>
        ) : null}
        {!icon192Url && !icon512Url ? (
          <p className="text-[11px] text-gray-400">
            {ct("messages.upload_or_paste_urls_to_preview", "上传或粘贴 URL 后显示", "Upload or paste URLs to preview")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** 列表项 id 在 JSON 中可能为 string 或 number，严格 === 会导致删不掉 / 误匹配 */
function entityIdsMatch(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

const UUID_RE_CLIENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 模板里的示例 UUID；上传导入时会跳过，避免误写入。 */
const ROLE_IMPORT_EXAMPLE_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function escapeCsvCell(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 表头：取「（」或「(」前的主 key，再压成与导入别名一致的 stem（如 user_id → userid）。 */
function roleImportHeaderStem(cell: unknown): string {
  let s = String(cell ?? "").trim().toLowerCase();
  for (const sep of ["（", "("]) {
    const i = s.indexOf(sep);
    if (i >= 0) {
      s = s.slice(0, i).trim();
      break;
    }
  }
  return s.replace(/_/g, "").replace(/\s+/g, "");
}

/** First spreadsheet row: need user_id (aliases), optional content_role / app_role. */
function detectRoleImportColumns(headerRow: unknown[]): { userIdx: number; contentIdx: number; appIdx: number } | null {
  let userIdx = -1;
  let contentIdx = -1;
  let appIdx = -1;
  const userKeys = new Set(["userid", "uuid", "user"]);
  const contentKeys = new Set(["contentrole", "cmsrole"]);
  const appKeys = new Set(["approle", "storerole"]);
  headerRow.forEach((cell, i) => {
    const k = roleImportHeaderStem(cell);
    if (userKeys.has(k)) userIdx = i;
    else if (contentKeys.has(k)) contentIdx = i;
    else if (appKeys.has(k)) appIdx = i;
  });
  if (userIdx < 0) return null;
  return { userIdx, contentIdx, appIdx };
}

function parseExcelContentRoleCell(raw: unknown): "none" | "editor" | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s === "none" || s === "clear" || s === "revoke" || s === "无" || s === "無") return "none";
  if (s === "editor" || s === "编辑" || s === "編輯") return "editor";
  return null;
}

function parseExcelAppRoleCell(raw: unknown): "farmer" | "distributor" | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s === "farmer" || s === "农户" || s === "農戶") return "farmer";
  if (s === "distributor" || s === "门店" || s === "分销商") return "distributor";
  return null;
}

function ensureMarketPageOnConfig(cfg: Record<string, unknown>): void {
  if (!cfg.marketPage || typeof cfg.marketPage !== 'object') {
    cfg.marketPage = { categories: [], products: [], advertisements: [] };
  }
  const mp = cfg.marketPage as Record<string, unknown>;
  if (!Array.isArray(mp.categories)) mp.categories = [];
  if (!Array.isArray(mp.products)) mp.products = [];
  if (!Array.isArray(mp.advertisements)) mp.advertisements = [];
}

type MarketCategoryLike = { id: string; subCategories?: string[] };

/** 保存一级分类时同步下属产品的 category / subCategory，返回应选中的一级 id */
function applyMarketCategoryCascade(
  newConfig: HomePageConfig,
  oldCategory: MarketCategoryLike | undefined,
  newCategory: MarketCategoryLike,
): string {
  ensureMarketPageOnConfig(newConfig as unknown as Record<string, unknown>);
  const products = (newConfig.marketPage!.products || []) as Array<{
    category?: string;
    subCategory?: string;
  }>;
  const oldId = oldCategory?.id != null ? String(oldCategory.id) : "";
  const newId = String(newCategory.id);
  const oldSubs = oldCategory?.subCategories || [];
  const newSubs = newCategory.subCategories || [];

  if (oldId && newId && oldId !== newId) {
    products.forEach((p) => {
      if (String(p.category) === oldId) p.category = newId;
    });
  }

  const catIdForSubs = newId || oldId;
  const maxLen = Math.min(oldSubs.length, newSubs.length);
  for (let i = 0; i < maxLen; i++) {
    const from = (oldSubs[i] || "").trim();
    const to = (newSubs[i] || "").trim();
    if (!from || !to || from === to) continue;
    products.forEach((p) => {
      if (String(p.category) === catIdForSubs && String(p.subCategory) === from) {
        p.subCategory = to;
      }
    });
  }

  return newId;
}

function stripMarketDockMeta<T extends Record<string, unknown>>(item: T): T {
  const { _type, ...rest } = item;
  void _type;
  return rest as T;
}

function countProductsInCategory(cfg: HomePageConfig, categoryId: string | number): number {
  const id = String(categoryId);
  return (cfg.marketPage?.products || []).filter((p) => String(p.category) === id).length;
}

export default function ConfigManagerPage() {
  const navigate = useNavigate();
  const {
    config,
    saveConfig,
    pushRemoteWithAuth,
    pullRemoteConfig,
    syncStatus,
    remoteVersion,
    lastSyncTime,
    lastSyncError,
    isRemoteConfigured,
  } = useConfigContext();
  const { t, language } = useLanguage();
  const { contentRole, loading: contentRoleLoading } = useContentSuperAdmin();

  // 进入动画
  const [animPhase, setAnimPhase] = useState<'entering' | 'visible'>('entering');
  useEffect(() => {
    const raf = requestAnimationFrame(() => setAnimPhase('visible'));
    return () => cancelAnimationFrame(raf);
  }, []);

  const [activeTab, setActiveTab] = useState<"supabase" | "banners" | "live" | "articles" | "market" | "marketCategories" | "marketProducts" | "marketAd" | "filing" | "aboutUs" | "privacy" | "terms" | "technicalSupport" | "appBranding" | "splashScreen" | "homeIcons" | "chatContact" | "desktopIcon" | "aiModel" | "backendProxy" | "loginConfig" | "pushProviders" | "pushNotification" | "userRoles">("banners");
  const [pushSendStatus, setPushSendStatus] = useState<"idle" | "sending" | "done">("idle");
  const [pushSendResult, setPushSendResult] = useState<{ sent: number; total: number; errors: number; results: string[] } | null>(null);
  const [pushForm, setPushForm] = useState({ title: "", body: "", url: "" });
  const [pushConfirmOpen, setPushConfirmOpen] = useState(false);
  const roleExcelInputRef = useRef<HTMLInputElement>(null);
  const [roleApplyBusy, setRoleApplyBusy] = useState(false);
  const [roleBulkResult, setRoleBulkResult] = useState<string | null>(null);
  const [roleSingleUserId, setRoleSingleUserId] = useState("");
  const [roleSingleContent, setRoleSingleContent] = useState<"" | "none" | "editor">("");
  const [roleSingleApp, setRoleSingleApp] = useState<"" | "farmer" | "distributor">("");
  const [editingItem, setEditingItem] = useState<any>(null);
  const [hasChanges, setHasChanges] = useState(false);
  // 市场 Dock 布局状态
  const [marketSubTab, setMarketSubTab] = useState<"products" | "ads">("products");
  const [selectedMarketCategory, setSelectedMarketCategory] = useState<string | null>(null);
  const hasChangesRef = useRef(hasChanges);
  hasChangesRef.current = hasChanges;
  // 本地工作副本：所有编辑操作只修改此副本，不立即持久化
  const [workingConfig, setWorkingConfig] = useState(() => JSON.parse(JSON.stringify(config)));
  // 打开内容管理器期间暂停「回到前台自动拉配置」，避免未推送的编辑被远程合并冲掉
  useEffect(() => {
    pauseConfigRemotePull();
    return () => resumeConfigRemotePull();
  }, []);
  // 进入页面后先拉取云端配置再对齐工作副本（避免首屏仍是旧 localStorage、推送时缺图标等）
  useEffect(() => {
    if (!isRemoteConfigured) return;
    let cancelled = false;
    void (async () => {
      await pullRemoteConfig();
      if (cancelled) return;
      const latest = storageGetJSON<HomePageConfig>(CONFIG_STORAGE_KEY);
      if (latest && !hasChangesRef.current) {
        setWorkingConfig(JSON.parse(JSON.stringify(latest)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isRemoteConfigured, pullRemoteConfig]);

  useEffect(() => {
    if (activeTab !== "userRoles") return;
    if (isDeveloperMode()) return;
    if (contentRoleLoading) return;
    if (contentRole !== "admin") setActiveTab("banners");
  }, [activeTab, contentRole, contentRoleLoading]);

  // Context 的 config 会在保存、reset、跨标签 storage 等之后更新；若用户未在编辑，把工作副本与最新 config 对齐
  useEffect(() => {
    if (!hasChanges) {
      setWorkingConfig(JSON.parse(JSON.stringify(config)));
    }
  }, [config, hasChanges]);
  /** 仅用于「推送到 Supabase」 */
  const [pushRemoteBusy, setPushRemoteBusy] = useState(false);
  // Sidebar open state (mobile)
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Sidebar collapsed groups
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const pwaIconInputRef = useRef<HTMLInputElement>(null);
  const pwaIconTargetRef = useRef<"main" | "drawer" | null>(null);
  const [pwaIconBusy, setPwaIconBusy] = useState(false);
  const [pwaIconErr, setPwaIconErr] = useState<string | null>(null);

  const [supabaseTestLoading, setSupabaseTestLoading] = useState(false);
  const [supabaseTestMessage, setSupabaseTestMessage] = useState<{
    kind: "ok" | "warn" | "err";
    text: string;
  } | null>(null);
  const supabaseTestMessageRef = useRef<HTMLParagraphElement>(null);

  const ct = createCmsTranslator(t, language, enTranslations);

  /** 内容管理器 → 发送通知（全语言走 i18n，与 en 合并兜底） */
  const cfgPush = (t.configManager?.pushNotification ?? {}) as Record<string, string>;
  const pushT = (key: string) => (typeof cfgPush[key] === "string" ? cfgPush[key] : "");

  /** 测试连接失败时的可读说明 + 可选技术细节 */
  const formatSupabaseTestFailure = (result: TestConnectionResult): string => {
    const detail = (result.error || "").trim();
    const appendDetail = (friendly: string) =>
      detail && detail.length > 0 ? `${friendly}\n${detail.slice(0, 280)}` : friendly;

    switch (result.hintKey) {
      case "missing_field":
        return ct("messages.please_enter_project_url_and_anon_key", "请填写 Project URL 和 Anon Key。", "Please enter Project URL and Anon Key.");
      case "placeholder":
        return ct("messages.replace_placeholders_with_the_real_project_url_and", "请替换占位符，使用 Supabase Dashboard → Settings → API 中的真实 Project URL 与 anon public key。", "Replace placeholders with the real Project URL and anon public key from Dashboard → Settings → API.");
      case "invalid_url":
        return ct("messages.invalid_project_url_must_be_a_full_https", "Project URL 格式无效（需为 https:// 开头的完整地址）。", "Invalid Project URL (must be a full https:// URL).");
      case "key_too_short":
        return ct("messages.url_or_anon_key_is_too_short_copy", "Anon Key 或 URL 过短。请从 Dashboard 完整复制 anon public key（通常为一长段 JWT）。", "URL or anon key is too short. Copy the full anon public key from Dashboard (usually a long JWT).");
      case "invalid_key_format":
        return ct("messages.anon_key_must_be_legacy_jwt_eyj_three", "Anon Key 格式不对：应为旧版 JWT（eyJ…，三段点分隔）或新版 sb_publishable_…。请从 Dashboard → API 复制 publishable / anon public。", "Anon key must be legacy JWT (eyJ… three segments) or new sb_publishable_…. Copy publishable / anon public from Dashboard → API.");
      case "unauthorized":
        return appendDetail(
          ct("messages.m_401_403_verify_the_anon_key_matches_this", "401/403：网关拒绝访问。请核对 anon key 是否与该项目一致，且使用 anon public（勿使用 service_role）。", "401/403: Verify the anon key matches this project and use anon public (not service_role)."),
        );
      case "edge_not_found":
        return appendDetail(
          ct("messages.m_404_edge_function_not_found_deploy_the_server", "404：未找到 Edge Function。请确认已部署 server 函数、Project URL 与函数名是否正确。", "404: Edge Function not found. Deploy the server function and verify URL and function name."),
        );
      case "timeout":
        return appendDetail(
          ct("messages.request_timed_out_15s_check_network_and_url", "请求超时（15 秒）。请检查网络、URL 是否正确，或稍后重试。", "Request timed out (15s). Check network and URL, or retry later."),
        );
      case "network":
        return appendDetail(
          ct("messages.cannot_reach_the_server_network_error_check_connectivity", "无法连接到服务器（网络错误）。请检查网络、防火墙或域名是否可达。", "Cannot reach the server (network error). Check connectivity and firewall."),
        );
      default:
        return appendDetail(
          ct(`连接失败${detail ? "：" + detail : "。"}`, `Connection failed${detail ? ": " + detail : "."}`),
        );
    }
  };

  const getEdgeFnAuth = async () => {
    const bp = (workingConfig as any)?.backendProxyConfig;
    const url = (bp?.supabaseUrl || "").trim().replace(/\/$/, "");
    const anon = (bp?.supabaseAnonKey || "").trim();
    const fn = (bp?.edgeFunctionName || "server").trim() || "server";
    if (!url || !anon) return null;
    const base = `${url}/functions/v1/${fn}`;
    const token = (await ensureEdgeSessionReady()) ?? "";
    return { base, anon, token };
  };

  const postUserRoleRows = async (
    rows: Array<Record<string, string>>,
  ): Promise<Array<{ userId: string; ok: boolean; error?: string }> | null> => {
    const auth = await getEdgeFnAuth();
    if (!auth) {
      alert(ct("messages.configure_server_connection_first", "请先配置服务器连接", "Configure server connection first"));
      return null;
    }
    if (!auth.token) {
      alert(ct("messages.sign_in_with_supabase_first", "请先登录 Supabase 会话", "Sign in with Supabase first"));
      return null;
    }
    const res = await fetch(`${auth.base}/admin/user-roles`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: auth.anon,
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ rows }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; results?: Array<{ userId: string; ok: boolean; error?: string }> };
    if (!res.ok) {
      alert(ct(`请求失败：${data?.error || res.statusText}`, `Request failed: ${data?.error || res.statusText}`));
      return null;
    }
    return data.results || [];
  };

  const applyUserRoleBatches = async (parsedRows: Array<Record<string, string>>) => {
    if (parsedRows.length === 0) {
      setRoleBulkResult(ct("messages.no_valid_rows_to_submit", "没有可提交的有效行", "No valid rows to submit"));
      return;
    }
    setRoleApplyBusy(true);
    setRoleBulkResult(null);
    try {
      let ok = 0;
      let fail = 0;
      const errLines: string[] = [];
      for (let i = 0; i < parsedRows.length; i += 200) {
        const chunk = parsedRows.slice(i, i + 200);
        const results = await postUserRoleRows(chunk);
        if (!results) {
          setRoleBulkResult(ct("messages.batch_apply_aborted", "批量应用已中断", "Batch apply aborted"));
          return;
        }
        for (const r of results) {
          if (r.ok) ok++;
          else {
            fail++;
            if (errLines.length < 40) errLines.push(`${r.userId}: ${r.error || "?"}`);
          }
        }
      }
      setRoleBulkResult(
        ct(`完成：成功 ${ok}，失败 ${fail}`, `Done: ${ok} ok, ${fail} failed`) +
          (errLines.length ? `\n${errLines.join("\n")}` : ""),
      );
    } finally {
      setRoleApplyBusy(false);
    }
  };

  const downloadDistributorsCsv = async () => {
    const auth = await getEdgeFnAuth();
    if (!auth) {
      alert(ct("messages.configure_server_connection_first", "请先配置服务器连接", "Configure server connection first"));
      return;
    }
    if (!auth.token) {
      alert(ct("messages.sign_in_with_supabase_first", "请先登录 Supabase 会话", "Sign in with Supabase first"));
      return;
    }
    setRoleApplyBusy(true);
    try {
      const res = await fetch(`${auth.base}/admin/distributors`, {
        headers: { apikey: auth.anon, Authorization: `Bearer ${auth.token}` },
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; rows?: Array<Record<string, unknown>> };
      if (!res.ok || !data?.ok) {
        alert(ct(`请求失败：${data?.error || res.statusText}`, `Request failed: ${data?.error || res.statusText}`));
        return;
      }
      const rows = data.rows || [];
      const header = [
        ct("messages.user_id_required_supabase_auth_uuid", "user_id（必填·勿改·Supabase Auth UUID）", "user_id (required · Supabase Auth UUID)"),
        ct("messages.display_name_read_only", "display_name（只读）", "display_name (read-only)"),
        ct("messages.phone_read_only", "phone（只读）", "phone (read-only)"),
        ct("messages.content_role_optional_lowercase_none_or_editor_no", "content_role（选填·英文 none 或 editor·勿用对勾）", "content_role (optional · lowercase none or editor · no checkmarks)"),
        ct("messages.app_role_optional_lowercase_farmer_or_distributor_no", "app_role（选填·英文 farmer 或 distributor·勿用对勾）", "app_role (optional · lowercase farmer or distributor · no checkmarks)"),
        ct("messages.updated_at_read_only", "updated_at（只读）", "updated_at (read-only)"),
      ];
      const legend = ct("messages.how_to_edit_change_only_content_role_and", "填写说明：若只改角色，请编辑「content_role」「app_role」两列；必须填英文小写单词 none / editor / farmer / distributor，不要用 √、不要写「是」或中文角色名。user_id 列请勿手改。", "How to edit: change only content_role and app_role using lowercase English (none, editor, farmer, distributor). No checkmarks. Do not edit user_id.");
      const lines = [
        header.map(escapeCsvCell).join(","),
        [escapeCsvCell(legend), "", "", "", "", ""].join(","),
        ...rows.map((r) => header.map((_, hi) => {
          const keys = ["user_id", "display_name", "phone", "content_role", "app_role", "updated_at"];
          return escapeCsvCell(r[keys[hi]]);
        }).join(",")),
      ];
      const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `distributors-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } finally {
      setRoleApplyBusy(false);
    }
  };

  const downloadRoleImportTemplate = () => {
    const h0 = ct("messages.user_id_required_uuid_from_supabase_auth", "user_id（必填·Supabase Auth 里用户的 UUID）", "user_id (required · UUID from Supabase Auth)");
    const h1 = ct("messages.content_role_optional_lowercase_none_or_editor_no", "content_role（选填·英文 none 或 editor·勿用对勾）", "content_role (optional · lowercase none or editor · no checkmarks)");
    const h2 = ct("messages.app_role_optional_lowercase_farmer_or_distributor_no", "app_role（选填·英文 farmer 或 distributor·勿用对勾）", "app_role (optional · lowercase farmer or distributor · no checkmarks)");
    const lines = [
      [escapeCsvCell(h0), escapeCsvCell(h1), escapeCsvCell(h2)].join(","),
      [
        escapeCsvCell(
          ct("messages.note_column_a_must_be_a_uuid_not", "（说明·勿在 A 列填中文当 UUID）三列均填英文小写：none / editor / farmer / distributor；不要用 √、不要用中文代替。none=撤内容权限；editor=内容编辑；farmer=农户壳；distributor=门店壳。某一格留空=上传时不改该项。", "(Note) Column A must be a UUID, not Chinese text. Use lowercase English: none / editor / farmer / distributor — no checkmarks. Blank cell = leave that field unchanged on upload."),
        ),
        "",
        "",
      ].join(","),
      [
        escapeCsvCell(
          ct("messages.next_row_is_an_example_delete_it_or", "下一行为示例：请删除该行或把 UUID 换成真实用户。若仍保留示例 UUID，上传时系统会自动忽略该行。", "Next row is an example — delete it or replace the UUID. The sample UUID is ignored on upload if left unchanged."),
        ),
        "",
        "",
      ].join(","),
      [ROLE_IMPORT_EXAMPLE_UUID, "editor", "distributor"].map(escapeCsvCell).join(","),
    ];
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "role-import-template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleRoleExcelFile = async (file: File | undefined) => {
    if (!file) return;
    setRoleBulkResult(null);
    try {
      const matrix = await readXlsxFile(file);
      if (!matrix || matrix.length < 2) {
        alert(ct("messages.spreadsheet_is_empty_or_has_no_data_rows", "表格为空或没有数据行", "Spreadsheet is empty or has no data rows"));
        return;
      }
      const header = matrix[0] as unknown[];
      const idx = detectRoleImportColumns(header);
      if (!idx) {
        alert(
          ct("messages.first_row_must_include_a_user_id_column", "首行需包含 user_id 列（表头可带中文说明，系统取「（」或「(」前的英文列名识别）。", "First row must include a user_id column (Chinese hints in headers are OK; we use the English part before '(')."),
        );
        return;
      }
      const out: Array<Record<string, string>> = [];
      for (let r = 1; r < matrix.length; r++) {
        const row = matrix[r] as unknown[];
        const uid = String(row[idx.userIdx] ?? "").trim();
        if (!UUID_RE_CLIENT.test(uid)) continue;
        if (uid === ROLE_IMPORT_EXAMPLE_UUID) continue;
        const contentRole = idx.contentIdx >= 0 ? parseExcelContentRoleCell(row[idx.contentIdx]) : null;
        const appRole = idx.appIdx >= 0 ? parseExcelAppRoleCell(row[idx.appIdx]) : null;
        const rec: Record<string, string> = { userId: uid };
        if (contentRole !== null) rec.contentRole = contentRole;
        if (appRole !== null) rec.appRole = appRole;
        if (!rec.contentRole && !rec.appRole) continue;
        out.push(rec);
      }
      if (out.length === 0) {
        alert(
          ct("messages.no_valid_rows_need_a_valid_uuid_and", "未解析到有效行（需合法 UUID，且至少填写 content_role 或 app_role 之一）", "No valid rows (need a valid UUID and at least content_role or app_role)"),
        );
        return;
      }
      await applyUserRoleBatches(out);
    } catch (e: any) {
      alert(ct(`读取表格失败：${e?.message || e}`, `Failed to read spreadsheet: ${e?.message || e}`));
    }
  };

  const applySingleUserRole = async () => {
    const uid = roleSingleUserId.trim();
    if (!UUID_RE_CLIENT.test(uid)) {
      alert(ct("messages.user_id_must_be_a_valid_uuid", "用户 ID 须为合法 UUID", "User ID must be a valid UUID"));
      return;
    }
    const rec: Record<string, string> = { userId: uid };
    if (roleSingleContent) rec.contentRole = roleSingleContent;
    if (roleSingleApp) rec.appRole = roleSingleApp;
    if (!rec.contentRole && !rec.appRole) {
      alert(ct("messages.select_at_least_one_role_field_to_write", "请至少选择一项要写入的角色", "Select at least one role field to write"));
      return;
    }
    await applyUserRoleBatches([rec]);
  };

  const runPwaCombinedIconUpload = async (file: File, target: "main" | "drawer") => {
    setPwaIconErr(null);
    if (file.size > MAX_PWA_SOURCE_IMAGE_BYTES) {
      setPwaIconErr(ct("messages.image_too_large_max_15mb", "图片过大（上限 15MB）", "Image too large (max 15MB)"));
      return;
    }
    if (!file.type.startsWith("image/")) {
      setPwaIconErr(ct("messages.please_choose_an_image_file", "请选择图片文件", "Please choose an image file"));
      return;
    }
    setPwaIconBusy(true);
    try {
      const { file192, file512 } = await renderPwaIconsFromImageFile(file);
      const [r1, r2] = await Promise.all([
        uploadFileToCmsPublic(file192),
        uploadFileToCmsPublic(file512),
      ]);
      const rlsMsg = ct("messages.upload_denied_content_admin_permission_required_see_deploy", "上传被拒绝：需要内容管理员权限。详见部署文档。", "Upload denied: content admin permission required. See deploy docs.");
      if ('error' in r1) {
        setPwaIconErr(r1.rlsDenied ? rlsMsg : r1.error);
        return;
      }
      if ('error' in r2) {
        setPwaIconErr(r2.rlsDenied ? rlsMsg : r2.error);
        return;
      }
      if (target === "main") {
        setWorkingConfig((prev) => {
          const newConfig = JSON.parse(JSON.stringify(prev)) as unknown as HomePageConfig;
          if (!newConfig.desktopIcon || typeof newConfig.desktopIcon !== "object") {
            newConfig.desktopIcon = { appName: "", icon192Url: "", icon512Url: "" };
          }
          newConfig.desktopIcon.icon192Url = r1.storagePath;
          newConfig.desktopIcon.icon512Url = r2.storagePath;
          return newConfig;
        });
        setHasChanges(true);
      } else {
        setEditingItem((prev: unknown) => {
          if (!prev || typeof prev !== "object") return prev;
          return {
        ...(prev as unknown as Record<string, unknown>),
            icon192Url: r1.storagePath,
            icon512Url: r2.storagePath,
          };
        });
      }
    } catch (e) {
      setPwaIconErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPwaIconBusy(false);
    }
  };

  useEffect(() => {
    if ((supabaseTestMessage || supabaseTestLoading) && supabaseTestMessageRef.current) {
      supabaseTestMessageRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [supabaseTestMessage, supabaseTestLoading]);

  // 处理返回：侧边栏打开时先关闭侧边栏，而不是离开页面
  const handleGoBack = () => {
    if (sidebarOpen) {
      setSidebarOpen(false);
      return;
    }
    if (hasChanges) {
      if (!confirm(ct("messages.you_have_unsaved_changes_are_you_sure_you", "有未保存的更改，确定要离开吗？", "You have unsaved changes. Are you sure you want to leave?"))) {
        return;
      }
    }
    // 使用 history.back，避免再压一条记录，导致「设置 → 返回」又回到本页
    if (typeof window !== "undefined" && window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/home/settings", { state: { settingsFrom: "/config-manager" } });
    }
  };

  /** 仅写入本机 + localStorage，用于在应用内预览；不调用 Supabase。 */
  const handleSaveLocalOnly = () => {
    if (pushRemoteBusy) return;
    saveConfig(workingConfig, { mirrorDevFiles: true });
    setHasChanges(false);
    alert(
      ct("messages.saved_locally_preview_in_the_app_when_ready", "已写入本机，可在应用中预览。确认无误后点击「推送到云端」向所有用户下发。", "Saved locally — preview in the app. When ready, use “Push to cloud” to publish for all users."),
    );
  };

  /** 将当前已保存的配置推送到 app_config（需先本地保存且无未提交编辑）。 */
  const handlePushToSupabase = async () => {
    if (pushRemoteBusy) return;
    if (hasChanges) {
      alert(
        ct("messages.use_save_locally_first_then_push_to_cloud", "请先点击「保存到本机」，确认后再推送。", "Use \"Save locally\" first, then push to cloud."),
      );
      return;
    }
    const url = workingConfig.backendProxyConfig?.supabaseUrl;
    const key = workingConfig.backendProxyConfig?.supabaseAnonKey;
    if (!isSupabaseConfigured(url, key)) {
      alert(
        ct("messages.enter_a_valid_project_url_and_anon_key", "请先在「服务器连接」中填写有效的 Project URL 与 Anon Key。", "Enter a valid Project URL and Anon Key under Server Connection first."),
      );
      return;
    }
    setPushRemoteBusy(true);
    try {
      const result = await pushRemoteWithAuth(workingConfig, remoteVersion);
      if (result.success) {
        alert(
          ct("messages.published_to_cloud_farmer_and_store_apps_will", "已推送到云端。农户/门店端在下次打开或回到前台时会拉取最新配置。", "Published to cloud. Farmer and store apps will fetch the latest config on next open or when returning to the foreground."),
        );
      } else if (result.conflict) {
        alert(
          ct("messages.remote_version_changed_reload_this_page_to_refresh", "云端版本已变更（他人已推送）。请刷新本页重新拉取版本后再试。", "Remote version changed. Reload this page to refresh the version, then try again."),
        );
      } else {
        alert(
          ct(
            `推送失败：${result.errorMessage || "未知错误"}`,
            `Push failed: ${result.errorMessage || "Unknown error"}`,
          ),
        );
      }
    } finally {
      setPushRemoteBusy(false);
    }
  };

  // 添加新项
  const handleAddItem = (type: string) => {
    const newItem = createNewItem(type);
    setEditingItem(newItem);
  };

  // 创建新项模板
  const createNewItem = (type: string) => {
    const items = getItemsByType(type);
    const maxId = items.length > 0 ? Math.max(0, ...items.map((item: any) => item.id || 0)) : 0;
    switch (type) {
      case "banners":
        return { id: maxId + 1, url: "", alt: "", title: "", content: "", videoUrl: "" };
      case "live":
        return { id: maxId + 1, title: "", viewers: "0", thumbnail: "", videoUrl: "" };
      case "articles":
        return { id: maxId + 1, title: "", content: "", thumbnail: "", videoUrl: "" };
      case "marketCategories":
        return { id: (maxId + 1).toString(), name: "", subCategories: [] };
      case "marketProducts":
        return { id: maxId + 1, name: "", image: "", price: "", category: "", subCategory: "", description: "", stock: 0, videoUrl: "" };
      case "marketAd":
        return { id: maxId + 1, image: "", title: "", content: "" };
      case "market":
        // Dock 布局：根据当前子标签创建对应类型的项
        if (marketSubTab === "ads") {
          return { id: maxId + 1, image: "", title: "", content: "" };
        }
        return { id: maxId + 1, name: "", image: "", price: "", category: selectedMarketCategory || "", subCategory: "", description: "", stock: 0, videoUrl: "" };
      case "filing":
        return { id: maxId + 1, icpNumber: "", icpUrl: "", policeNumber: "", policeUrl: "" };
      case "aboutUs":
        return { id: maxId + 1, content: "" };
      case "privacy":
        return { id: maxId + 1, content: "" };
      case "terms":
        return { id: maxId + 1, content: "" };
      case "technicalSupport":
        return { id: maxId + 1, title: "", content: "" };
      case "appBranding":
        return { logoUrl: "", appName: "", slogan: "" };
      case "splashScreen":
        return { id: maxId + 1, imageUrl: "", minDisplayMs: 2000, maxResourceWaitMs: 4000, showSkipButton: true };
      case "chatContact":
        return { merchantUserId: "", channelId: "", name: "", avatar: "", subtitle: "", verifiedDomains: [] };
      case "desktopIcon":
        return { appName: "", icon192Url: "", icon512Url: "" };
      case "aiModel":
        return { id: maxId + 1, name: "", description: "", parameters: "" };
      default:
        return {};
    }
  };

  // 获取当前标签的数据
  // 注意：不得依赖 marketPage 作为全局前置条件 —— 轮播/直播/文章等不属商城，缺 marketPage 时仍应能列出与编辑。
  const getItemsByType = (type: string) => {
    const wc = workingConfig;
    if (!wc) return [];
    switch (type) {
      case "banners": return wc.banners || [];
      case "live": return wc.liveStreams || [];
      case "articles": return wc.articles || [];
      case "marketCategories": return wc.marketPage?.categories || [];
      case "marketProducts": return wc.marketPage?.products || [];
      case "marketAd":
        return wc.marketPage?.advertisements || [];
      case "market": return []; // Dock 布局自行渲染，不用卡片网格
      case "filing": return wc.filing ? [wc.filing] : [];
      case "aboutUs": return wc.aboutUs ? [wc.aboutUs] : [];
      case "privacy": return wc.privacyPolicy ? [wc.privacyPolicy] : [];
      case "terms": return wc.termsOfService ? [wc.termsOfService] : [];
      case "technicalSupport": return wc.technicalSupport ? [wc.technicalSupport] : [];
      case "appBranding": return wc.appBranding ? [wc.appBranding] : [];
      case "splashScreen": return wc.splashScreen ? [{ id: 1, ...wc.splashScreen }] : [];
      case "chatContact": return wc.chatContact ? [wc.chatContact] : [];
      case "desktopIcon": return wc.desktopIcon ? [wc.desktopIcon] : [];
      // aiModel tab 使用直接表单渲染（aiModelConfig + cloudAIConfig），不走卡片网格
      case "aiModel": return [];
      case "pushNotification": return [];
      case "userRoles": return [];
      default: return [];
    }
  };

  // 保存编辑
  const handleSaveEdit = () => {
    if (!editingItem) return;

    // 深拷贝配置，避免直接修改原数组引用导致 React 检测不到变化
    const newConfig = JSON.parse(JSON.stringify(workingConfig)) as typeof config;

    // 对于 market Dock 布局，根据 editingItem._type 查找正确的数组
    const items =
      activeTab === "market"
        ? editingItem._type === "category"
          ? (newConfig.marketPage?.categories || [])
          : editingItem._type === "ad"
            ? (newConfig.marketPage?.advertisements || [])
            : (newConfig.marketPage?.products || [])
        : getItemsByType(activeTab);

    const existingIndex = items.findIndex((item: any) =>
      entityIdsMatch(item.id, editingItem.id),
    );

    if (existingIndex >= 0) {
      // 更新现有项
      switch (activeTab) {
        case "banners":
          newConfig.banners[existingIndex] = editingItem;
          break;
        case "live":
          newConfig.liveStreams[existingIndex] = editingItem;
          break;
        case "articles":
          newConfig.articles[existingIndex] = editingItem;
          break;
        case "marketCategories": {
          const oldCat = workingConfig.marketPage?.categories?.[existingIndex] as MarketCategoryLike | undefined;
          const savedCat = stripMarketDockMeta(editingItem) as MarketCategoryLike;
          newConfig.marketPage.categories[existingIndex] = savedCat;
          const newCatId = applyMarketCategoryCascade(newConfig, oldCat, savedCat);
          if (selectedMarketCategory === oldCat?.id) {
            setSelectedMarketCategory(newCatId);
          }
          break;
        }
        case "marketProducts":
          newConfig.marketPage.products[existingIndex] = editingItem;
          break;
        case "marketAd":
          newConfig.marketPage.advertisements[existingIndex] = editingItem;
          break;
        case "market":
          // Dock 布局：根据 _type 更新对应数组
          ensureMarketPageOnConfig(newConfig as unknown as Record<string, unknown>);
          if (editingItem._type === "category") {
            const oldCat = workingConfig.marketPage?.categories?.[existingIndex] as MarketCategoryLike | undefined;
            const savedCat = stripMarketDockMeta(editingItem) as MarketCategoryLike;
            newConfig.marketPage!.categories[existingIndex] = savedCat;
            const newCatId = applyMarketCategoryCascade(newConfig, oldCat, savedCat);
            if (selectedMarketCategory === oldCat?.id || selectedMarketCategory === null) {
              setSelectedMarketCategory(newCatId);
            }
          } else if (editingItem._type === "ad") {
            newConfig.marketPage!.advertisements[existingIndex] = stripMarketDockMeta(editingItem);
          } else {
            newConfig.marketPage!.products[existingIndex] = stripMarketDockMeta(editingItem);
          }
          break;
        case "filing":
          newConfig.filing = editingItem;
          break;
        case "aboutUs":
          newConfig.aboutUs = editingItem;
          break;
        case "privacy":
          newConfig.privacyPolicy = editingItem;
          break;
        case "terms":
          newConfig.termsOfService = editingItem;
          break;
        case "technicalSupport":
          newConfig.technicalSupport = editingItem;
          break;
        case "appBranding":
          newConfig.appBranding = editingItem;
          break;
        case "splashScreen":
          newConfig.splashScreen = {
            imageUrl: String(editingItem.imageUrl ?? ''),
            minDisplayMs: Math.max(0, Number(editingItem.minDisplayMs) || 2000),
            maxResourceWaitMs: Math.max(300, Number(editingItem.maxResourceWaitMs) || 4000),
            showSkipButton: editingItem.showSkipButton !== false,
          };
          break;
        case "chatContact":
          newConfig.chatContact = editingItem;
          break;
        case "desktopIcon":
          newConfig.desktopIcon = editingItem;
          break;
        // aiModel: 直接表单编辑，不走此路径
      }
    } else {
      // 添加新项
      switch (activeTab) {
        case "banners":
          if (!newConfig.banners) newConfig.banners = [];
          newConfig.banners.push(editingItem);
          break;
        case "live":
          if (!newConfig.liveStreams) newConfig.liveStreams = [];
          newConfig.liveStreams.push(editingItem);
          break;
        case "articles":
          if (!newConfig.articles) newConfig.articles = [];
          newConfig.articles.push(editingItem);
          break;
        case "marketCategories":
          if (!newConfig.marketPage) {
            newConfig.marketPage = { categories: [], products: [], advertisements: [] } as typeof newConfig.marketPage;
          }
          if (!newConfig.marketPage.categories) newConfig.marketPage.categories = [];
          newConfig.marketPage.categories.push(stripMarketDockMeta(editingItem));
          break;
        case "marketProducts":
          if (!newConfig.marketPage) {
            newConfig.marketPage = { categories: [], products: [], advertisements: [] } as typeof newConfig.marketPage;
          }
          if (!newConfig.marketPage.products) newConfig.marketPage.products = [];
          newConfig.marketPage.products.push(editingItem);
          break;
        case "marketAd":
          if (!newConfig.marketPage) {
            newConfig.marketPage = { categories: [], products: [], advertisements: [] } as typeof newConfig.marketPage;
          }
          if (!newConfig.marketPage.advertisements) newConfig.marketPage.advertisements = [];
          newConfig.marketPage.advertisements.push(editingItem);
          break;
        case "market":
          // Dock 布局：根据 _type 添加到对应数组
          ensureMarketPageOnConfig(newConfig as unknown as Record<string, unknown>);
          if (editingItem._type === "category") {
            if (!newConfig.marketPage!.categories) newConfig.marketPage!.categories = [];
            const savedCat = stripMarketDockMeta(editingItem) as MarketCategoryLike;
            newConfig.marketPage!.categories.push(savedCat);
            setSelectedMarketCategory(String(savedCat.id));
          } else if (editingItem._type === "ad") {
            if (!newConfig.marketPage!.advertisements) newConfig.marketPage!.advertisements = [];
            newConfig.marketPage!.advertisements.push(stripMarketDockMeta(editingItem));
          } else {
            if (!newConfig.marketPage!.products) newConfig.marketPage!.products = [];
            newConfig.marketPage!.products.push(stripMarketDockMeta(editingItem));
          }
          break;
        case "filing":
          newConfig.filing = editingItem;
          break;
        case "aboutUs":
          newConfig.aboutUs = editingItem;
          break;
        case "privacy":
          newConfig.privacyPolicy = editingItem;
          break;
        case "terms":
          newConfig.termsOfService = editingItem;
          break;
        case "technicalSupport":
          newConfig.technicalSupport = editingItem;
          break;
        case "appBranding":
          newConfig.appBranding = editingItem;
          break;
        case "splashScreen":
          newConfig.splashScreen = {
            imageUrl: String(editingItem.imageUrl ?? ''),
            minDisplayMs: Math.max(0, Number(editingItem.minDisplayMs) || 2000),
            maxResourceWaitMs: Math.max(300, Number(editingItem.maxResourceWaitMs) || 4000),
            showSkipButton: editingItem.showSkipButton !== false,
          };
          break;
        case "chatContact":
          newConfig.chatContact = editingItem;
          break;
        case "desktopIcon":
          newConfig.desktopIcon = editingItem;
          break;
        // aiModel: 直接表单编辑，不走此路径
      }
    }

    setWorkingConfig(newConfig);
    setEditingItem(null);
    setHasChanges(true);
  };

  // 删除项
  const handleDeleteItem = (id: number | string, itemType?: string) => {
    const isMarketCategoryDelete =
      itemType === "category" && (activeTab === "market" || activeTab === "marketCategories");
    if (isMarketCategoryDelete) {
      const n = countProductsInCategory(workingConfig, id);
      const msg =
        n > 0
          ? ct(
              `确定删除该类别？将同时删除其下 ${n} 个产品，且无法撤销。`,
              `Delete this category and its ${n} product(s)? This cannot be undone.`,
            )
          : ct("messages.delete_this_category", "确定要删除该类别吗？", "Delete this category?");
      if (!confirm(msg)) return;
    } else if (!confirm(ct("messages.are_you_sure_you_want_to_delete_this", "确定要删除这项吗？", "Are you sure you want to delete this item?"))) {
      return;
    }

    const newConfig = JSON.parse(JSON.stringify(workingConfig)) as typeof config;
    switch (activeTab) {
      case "banners":
        newConfig.banners = workingConfig.banners.filter(
          (item: any) => !entityIdsMatch(item.id, id),
        );
        break;
      case "live":
        newConfig.liveStreams = workingConfig.liveStreams.filter(
          (item: any) => !entityIdsMatch(item.id, id),
        );
        break;
      case "articles":
        newConfig.articles = workingConfig.articles.filter(
          (item: any) => !entityIdsMatch(item.id, id),
        );
        break;
      case "marketCategories": {
        ensureMarketPageOnConfig(newConfig as unknown as Record<string, unknown>);
        const catId = String(id);
        newConfig.marketPage!.categories = (workingConfig.marketPage?.categories || []).filter(
          (item: any) => !entityIdsMatch(item.id, id),
        );
        newConfig.marketPage!.products = (workingConfig.marketPage?.products || []).filter(
          (item: any) => String(item.category) !== catId,
        );
        if (selectedMarketCategory === catId) {
          const next = newConfig.marketPage!.categories[0]?.id;
          setSelectedMarketCategory(next != null ? String(next) : null);
        }
        break;
      }
      case "marketProducts":
        ensureMarketPageOnConfig(newConfig as unknown as Record<string, unknown>);
        newConfig.marketPage!.products = (workingConfig.marketPage?.products || []).filter(
          (item: any) => !entityIdsMatch(item.id, id),
        );
        break;
      case "marketAd":
        ensureMarketPageOnConfig(newConfig as unknown as Record<string, unknown>);
        newConfig.marketPage!.advertisements = (workingConfig.marketPage?.advertisements || []).filter(
          (item: any) => !entityIdsMatch(item.id, id),
        );
        break;
      case "market": {
        // Dock 布局：根据 itemType 只删除对应数组中的项，避免 ID 冲突导致误删
        ensureMarketPageOnConfig(newConfig as unknown as Record<string, unknown>);

        if (itemType === "category") {
          const catId = String(id);
          newConfig.marketPage!.categories = (workingConfig.marketPage?.categories || []).filter(
            (item: any) => !entityIdsMatch(item.id, id),
          );
          newConfig.marketPage!.products = (workingConfig.marketPage?.products || []).filter(
            (item: any) => String(item.category) !== catId,
          );
          if (selectedMarketCategory === catId) {
            const next = newConfig.marketPage!.categories[0]?.id;
            setSelectedMarketCategory(next != null ? String(next) : null);
          }
        } else if (itemType === "ad") {
          newConfig.marketPage!.advertisements = (workingConfig.marketPage?.advertisements || []).filter(
            (item: any) => !entityIdsMatch(item.id, id),
          );
        } else {
          // 默认：产品（向后兼容无 itemType 的旧调用）
          newConfig.marketPage!.products = (workingConfig.marketPage?.products || []).filter(
            (item: any) => !entityIdsMatch(item.id, id),
          );
        }
        break;
      }
      // 单体配置类型：重置为默认值而非null，防止崩溃
      case "filing":
        newConfig.filing = { icpNumber: "", icpUrl: "", policeNumber: "", policeUrl: "" };
        break;
      case "aboutUs":
        newConfig.aboutUs = { title: "", content: "" };
        break;
      case "privacy":
        newConfig.privacyPolicy = { title: "", content: "" };
        break;
      case "terms":
        newConfig.termsOfService = { title: "", content: "" };
        break;
      case "technicalSupport":
        newConfig.technicalSupport = { title: "", content: "" };
        break;
      case "appBranding":
        newConfig.appBranding = { logoUrl: "", appName: "", slogan: "" };
        break;
      case "splashScreen":
        newConfig.splashScreen = { imageUrl: "", minDisplayMs: 2000, maxResourceWaitMs: 4000, showSkipButton: true };
        break;
      case "chatContact":
        newConfig.chatContact = { merchantUserId: "", channelId: "", name: "", avatar: "", subtitle: "", verifiedDomains: [] };
        break;
      case "desktopIcon":
        newConfig.desktopIcon = { appName: "", icon192Url: "", icon512Url: "" };
        break;
      // aiModel: 直接表单编辑，不走删除路径
    }

    setWorkingConfig(newConfig);
    setHasChanges(true);
    setEditingItem((prev: any) =>
      prev != null && entityIdsMatch(prev.id, id) ? null : prev,
    );
  };

  /** 置顶白名单与弹窗内 chatContact 编辑共用，保持 workingConfig 与已打开的编辑项一致 */
  const patchChatContactDomains = (nextDomains: string[]) => {
    const newConfig = JSON.parse(JSON.stringify(workingConfig)) as typeof config;
    const base = newConfig.chatContact || {
      merchantUserId: "",
      channelId: "",
      name: "",
      avatar: "",
      subtitle: "",
      verifiedDomains: [] as string[],
    };
    newConfig.chatContact = { ...base, verifiedDomains: nextDomains };
    setWorkingConfig(newConfig);
    setHasChanges(true);
    setEditingItem((prev: any) =>
      activeTab === "chatContact" && prev ? { ...prev, verifiedDomains: nextDomains } : prev,
    );
  };

  // 市场 Dock 布局：仿 MarketPage（窄左栏 + 右上广告 + 右下二列产品网格，子类别分组）
  const renderMarketDock = () => {
    const categories = workingConfig?.marketPage?.categories || [];
    const allProducts = workingConfig?.marketPage?.products || [];
    const ads = workingConfig?.marketPage?.advertisements || [];

    const selectedCat = selectedMarketCategory || (categories.length > 0 ? categories[0].id : null);

    // 选中类别的子类别
    const catObj = categories.find((c) => c.id === selectedCat);
    const subCategories: string[] = catObj?.subCategories || [];

    // 选中类别的产品，按子类别分组
    const filteredProducts = selectedCat
      ? allProducts.filter((p) => p.category === selectedCat)
      : allProducts;

    const groupedBySub = new Map<string, any[]>();
    if (selectedCat) {
      subCategories.forEach((sc) => groupedBySub.set(sc, []));
    }
    filteredProducts.forEach((p) => {
      const key = p.subCategory || "";
      if (!groupedBySub.has(key)) groupedBySub.set(key, []);
      groupedBySub.get(key)!.push(p);
    });

    // ---- 类别操作 ----
    const handleCategoryReorder = (newCats: typeof categories) => {
      const nc = JSON.parse(JSON.stringify(workingConfig)) as typeof config;
      ensureMarketPageOnConfig(nc as unknown as Record<string, unknown>);
      nc.marketPage!.categories = newCats;
      setWorkingConfig(nc);
      setHasChanges(true);
    };

    const handleSaveProductReorder = (items: any[]) => {
      const nc = JSON.parse(JSON.stringify(workingConfig)) as typeof config;
      ensureMarketPageOnConfig(nc as unknown as Record<string, unknown>);
      if (selectedCat) {
        const other = allProducts.filter((p) => p.category !== selectedCat);
        nc.marketPage!.products = [...other, ...items];
      } else {
        nc.marketPage!.products = items;
      }
      setWorkingConfig(nc);
      setHasChanges(true);
    };

    const handleSaveAdReorder = (items: any[]) => {
      const nc = JSON.parse(JSON.stringify(workingConfig)) as typeof config;
      ensureMarketPageOnConfig(nc as unknown as Record<string, unknown>);
      nc.marketPage!.advertisements = items;
      setWorkingConfig(nc);
      setHasChanges(true);
    };

    const openEdit = (item: any, type: string) => {
      setEditingItem({ ...item, _type: type });
    };

    const openNewCategory = () => {
      const maxId = categories.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0);
      setEditingItem({ id: String(maxId + 1), name: "", subCategories: [], _type: "category" });
    };

    const openNewProduct = (prefillSubCategory?: string) => {
      const maxId = allProducts.reduce((m, p) => Math.max(m, p.id || 0), 0);
      setEditingItem({
        id: maxId + 1, name: "", image: "", price: "",
        category: selectedCat || "",
        subCategory: prefillSubCategory || "",
        description: "", stock: 0, videoUrl: "",
        _type: "product",
      });
    };

    const subCatDisplayOrder: Array<{ key: string; prods: any[] }> = [];
    subCategories.forEach((sc) => {
      subCatDisplayOrder.push({ key: sc, prods: groupedBySub.get(sc) || [] });
    });
    Array.from(groupedBySub.entries()).forEach(([key, prods]) => {
      if (key && !subCategories.includes(key)) {
        subCatDisplayOrder.push({ key, prods });
      }
    });
    if (groupedBySub.has("")) {
      subCatDisplayOrder.push({ key: "", prods: groupedBySub.get("") || [] });
    }

    const renderSubCategorySection = (subCat: string, prods: any[]) => (
      <div key={subCat || "__uncategorized__"}>
        {subCat ? (
          <div className="flex items-center gap-2 mb-2">
            <span className="w-1 h-4 bg-emerald-600 rounded-full flex-shrink-0" />
            <h3 className="text-sm font-semibold text-gray-800">{subCat}</h3>
            <span className="text-[11px] text-gray-400">({prods.length})</span>
          </div>
        ) : prods.length > 0 ? (
          <div className="flex items-center gap-2 mb-2">
            <span className="w-1 h-4 bg-gray-400 rounded-full flex-shrink-0" />
            <h3 className="text-sm font-semibold text-gray-600">
              {ct("messages.uncategorized_subcategory", "未归类子类别", "Uncategorized subcategory")}
            </h3>
            <span className="text-[11px] text-gray-400">({prods.length})</span>
          </div>
        ) : null}
        {prods.length === 0 ? (
          <button
            type="button"
            onClick={() => openNewProduct(subCat || undefined)}
            className="w-full mb-3 border border-dashed border-gray-200 rounded-lg py-4 text-gray-400 hover:border-emerald-400 hover:text-emerald-600 transition-colors text-xs flex flex-col items-center gap-1"
          >
            <Plus className="w-4 h-4" />
            {ct("messages.no_products_in_this_subcategory_tap_to_add", "该子类别暂无产品，点击添加", "No products in this subcategory — tap to add")}
          </button>
        ) : (
          <>
            <SortableList
              items={prods}
              onReorder={(newItems) => {
                const all = [...groupedBySub.entries()].flatMap(([sc, p]) =>
                  sc === subCat ? newItems : p,
                );
                handleSaveProductReorder(all);
              }}
              itemKey={(item) => `${item.id}`}
              showHandle={false}
              className="grid grid-cols-2 gap-3 mb-2"
              renderItem={(product) => (
                <div className="bg-white rounded-xl overflow-hidden border border-gray-200 shadow-sm hover:shadow-md transition-all group cursor-grab active:cursor-grabbing">
                  <div className="aspect-square bg-gray-100 relative">
                    {product.image ? (
                      <CmsMediaImg src={product.image} alt={product.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-300">
                        <Plus className="w-6 h-6" />
                      </div>
                    )}
                  </div>
                  <div className="p-2">
                    <p className="text-xs text-gray-800 font-medium line-clamp-2 min-h-[2rem]">{product.name || "-"}</p>
                    {product.price && (
                      <p className="text-sm font-semibold text-emerald-600 mt-0.5">{product.price}</p>
                    )}
                  </div>
                  <div className="border-t border-gray-100 px-2 py-1.5 flex items-center justify-between bg-gray-50/60">
                    <button
                      onClick={(e) => { e.stopPropagation(); openEdit(product, "product"); }}
                      className="flex items-center gap-1 text-[10px] text-emerald-600 hover:bg-emerald-50 px-2 py-1 rounded transition-colors"
                    >
                      <Edit3 className="w-3 h-3" />{ct("buttons.edit", "编辑", "Edit")}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteItem(product.id, "product"); }}
                      className="flex items-center gap-1 text-[10px] text-red-500 hover:bg-red-50 px-2 py-1 rounded transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />{ct("buttons.delete", "删除", "Delete")}
                    </button>
                  </div>
                </div>
              )}
            />
            <button
              type="button"
              onClick={() => openNewProduct(subCat || undefined)}
              className="w-full mb-3 border border-dashed border-gray-200 rounded-lg py-2.5 text-gray-500 hover:border-emerald-400 hover:text-emerald-600 transition-colors text-xs flex items-center justify-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              {ct("messages.add_product_under_this_subcategory", "在此二级分类下添加产品", "Add product under this subcategory")}
            </button>
          </>
        )}
      </div>
    );

    const openNewAd = () => {
      const maxId = ads.reduce((m, a) => Math.max(m, a.id || 0), 0);
      setEditingItem({ id: maxId + 1, image: "", title: "", content: "", _type: "ad" });
    };

    return (
      <div className="flex gap-0 h-full bg-gray-50 overflow-hidden">
        {/* 左侧：窄类别栏 (仿 MarketPage w-20)；支持拖拽上下调整顺序 */}
        <div className="w-20 flex-shrink-0 overflow-y-auto border-r border-gray-200 bg-white flex flex-col">
          {categories.length > 1 ? (
            <p className="text-[9px] text-gray-400 px-1 py-1 text-center leading-tight border-b border-gray-100">
              {ct("messages.______", "Drag to reorder", "Drag to reorder")}
            </p>
          ) : null}
          {categories.length > 0 ? (
            <SortableList
              items={categories as { id: string | number }[]}
              onReorder={handleCategoryReorder}
              itemKey={(cat) => `dock-cat-${String(cat.id)}`}
              showHandle={false}
              className="flex flex-col"
              renderItem={(cat: (typeof categories)[number]) => (
                <div className="group/cat relative cursor-grab active:cursor-grabbing border-b border-gray-50 last:border-0">
                  <button
                    type="button"
                    onClick={() => setSelectedMarketCategory(cat.id)}
                    className={`w-full py-3 px-1.5 text-center transition-all relative ${
                      selectedCat === cat.id
                        ? "bg-emerald-50 text-emerald-700 font-medium shadow-sm"
                        : "text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {selectedCat === cat.id && (
                      <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-emerald-600 rounded-r-full" />
                    )}
                    <div className="text-[11px] leading-tight line-clamp-2 break-words pointer-events-none">{cat.name || ct("commonLabels.unnamed", "未命名", "Unnamed")}</div>
                    {cat.subCategories?.length > 0 && (
                      <div className="text-[9px] text-gray-400 mt-0.5 pointer-events-none">{cat.subCategories.length} sub</div>
                    )}
                  </button>
                  <div className="absolute top-1 right-0.5 hidden group-hover/cat:flex gap-0.5 z-[1]">
                    <button
                      type="button"
                      draggable={false}
                      onClick={(e) => { e.stopPropagation(); openEdit(cat, "category"); }}
                      className="p-0.5 bg-white rounded shadow border border-gray-200 text-gray-500 hover:text-emerald-600 cursor-pointer"
                      title={ct("buttons.editCategory", "编辑类别", "Edit Category")}
                    >
                      <Edit3 className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      draggable={false}
                      onClick={(e) => { e.stopPropagation(); handleDeleteItem(cat.id, "category"); }}
                      className="p-0.5 bg-white rounded shadow border border-gray-200 text-gray-500 hover:text-red-600 cursor-pointer"
                      title={ct("buttons.deleteCategory", "删除类别", "Delete Category")}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              )}
            />
          ) : null}
          <div className="border-t border-gray-100 pt-1 px-1">
            <button
              onClick={openNewCategory}
              className="w-full text-[10px] text-emerald-600 hover:bg-emerald-50 py-2 rounded transition-colors flex items-center justify-center gap-0.5"
            >
              <Plus className="w-3 h-3" />{ct("buttons.add", "添加", "Add")}
            </button>
          </div>
        </div>

        {/* 右侧：广告位 + 产品网格 */}
        <div className="flex-1 overflow-y-auto bg-white">
          {/* ── 广告位 (仿 MarketPage carousel banner) ── */}
          {ads.length === 0 ? (
            <div className="mx-3 mt-3">
              <button
                onClick={openNewAd}
                className="w-full aspect-[3/1] border-2 border-dashed border-gray-300 rounded-lg flex items-center justify-center text-gray-400 hover:border-emerald-400 hover:text-emerald-500 transition-colors"
              >
                <div className="text-center">
                  <Plus className="w-6 h-6 mx-auto mb-1" />
                  <span className="text-xs">{ct("buttons.addAd", "添加广告位", "Add Ad Banner")}</span>
                </div>
              </button>
            </div>
          ) : (
            <div className="mx-3 mt-3 mb-1">
              {/* 首位广告大图预览 */}
              <div className="relative overflow-hidden rounded-lg border border-gray-200 group/ad">
                <CmsMediaImg
                  src={ads[0]?.image || ""}
                  alt={ads[0]?.title || "Ad"}
                  className="w-full aspect-[3/1] object-cover bg-gray-100"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
                {ads[0]?.title && (
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-4">
                    <p className="text-white text-[10px] truncate">{ads[0].title}</p>
                  </div>
                )}
                {/* 当前广告编辑/删除 */}
                <div className="absolute top-2 right-2 hidden group-hover/ad:flex gap-1">
                  <button
                    onClick={() => openEdit(ads[0], "ad")}
                    className="p-1 bg-white/90 rounded shadow text-gray-600 hover:text-emerald-600"
                    title={ct("buttons.editAd", "编辑广告", "Edit Ad")}
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDeleteItem(ads[0].id, "ad")}
                    className="p-1 bg-white/90 rounded shadow text-gray-600 hover:text-red-600"
                    title={ct("buttons.deleteAd", "删除广告", "Delete Ad")}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* 广告排序列表（所有广告可拖拽重排） */}
              <div className="mt-2">
                <p className="text-[10px] text-gray-400 mb-1">{ads.length > 1 ? ct("buttons.dragToReorder", "拖拽排序广告（首位为预览大图）", "Drag to reorder (first is preview)") : ""}</p>
                <SortableList
                  items={ads}
                  onReorder={handleSaveAdReorder}
                  itemKey={(item) => `${item.id}`}
                  showHandle={true}
                  className="space-y-1"
                  renderItem={(ad, idx) => (
                    <div className={`flex items-center gap-2 p-1.5 rounded-lg bg-white border transition-colors ${idx === 0 ? 'border-emerald-400 shadow-sm' : 'border-gray-200 hover:border-gray-300'}`}>
                      <div className="w-10 h-8 rounded bg-gray-100 overflow-hidden flex-shrink-0">
                        {ad.image ? (
                          <CmsMediaImg src={ad.image} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-300 text-[10px]">-</div>
                        )}
                      </div>
                      <span className="text-[11px] text-gray-600 flex-1 truncate">{ad.title || ct("commonLabels.unnamedAd", "未命名广告", "Untitled Ad")}</span>
                      <div className="flex gap-0.5 flex-shrink-0">
                        <button onClick={(e) => { e.stopPropagation(); openEdit(ad, "ad"); }} className="p-0.5 text-gray-400 hover:text-emerald-600" title={ct("buttons.edit", "编辑", "Edit")}>
                          <Edit3 className="w-3 h-3" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); handleDeleteItem(ad.id, "ad"); }} className="p-0.5 text-gray-400 hover:text-red-600" title={ct("buttons.delete", "删除", "Delete")}>
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  )}
                />
              </div>

              {/* 新增广告按钮 */}
              <div className="flex justify-end gap-2 mt-1.5">
                <button onClick={openNewAd} className="text-[10px] text-emerald-600 hover:text-emerald-700 flex items-center gap-0.5">
                  <Plus className="w-3 h-3" />{ct("buttons.newAd", "新增广告", "New Ad")}
                </button>
              </div>
            </div>
          )}

          {/* ── 产品区域：按子类别分组 ── */}
          <div className="px-3 pt-3 pb-4">
            {!selectedCat ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                <p className="text-sm">{ct("messages.select_a_category_to_view_products", "请选择左侧类别查看产品", "Select a category to view products")}</p>
              </div>
            ) : filteredProducts.length === 0 && subCategories.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                <p className="text-sm mb-2">{ct("messages.no_products_in_this_category", "该类别暂无产品", "No products in this category")}</p>
                <button
                  type="button"
                  onClick={() => openNewProduct()}
                  className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-xs flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" />{ct("buttons.addProduct", "添加产品", "Add Product")}
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {subCatDisplayOrder.map(({ key, prods }) => renderSubCategorySection(key, prods))}
                <button
                  type="button"
                  onClick={() => openNewProduct()}
                  className="w-full border-2 border-dashed border-gray-300 rounded-lg py-3 text-gray-400 hover:border-emerald-400 hover:text-emerald-500 transition-colors flex items-center justify-center gap-1"
                >
                  <Plus className="w-4 h-4" />
                  <span className="text-xs">{ct("messages.add_product_to", "添加产品到 ", "Add product to ")}{catObj?.name || selectedCat}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // 渲染卡片网格
  const renderTable = () => {
    // 市场管理 Dock 布局
    if (activeTab === "market") return renderMarketDock();

    const items = getItemsByType(activeTab);

    if (items.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400">
          <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-3">
            <Plus className="w-6 h-6 text-gray-300" />
          </div>
          <p className="text-sm">{ct("commonLabels.noData", "暂无数据", "No data yet")}</p>
          <p className="text-xs mt-1">{ct("messages.click_add_to_create_a_new_item", "点击右上角\"添加\"按钮创建新项", "Click \"Add\" to create a new item")}</p>
        </div>
      );
    }

    const Field = ({ label, value, mono = false }: { label: string; value: any; mono?: boolean }) => {
      if (!value && value !== 0) return null;
      const displayVal = typeof value === 'string' && value.length > 80 ? value.slice(0, 80) + '…' : value;
      return (
        <div className="min-w-0">
          <span className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</span>
          <p className={`text-xs text-gray-700 mt-0.5 truncate ${mono ? 'font-mono' : ''}`} title={typeof value === 'string' ? value : undefined}>{displayVal || '-'}</p>
        </div>
      );
    };

    const Thumb = ({ src, alt }: { src?: string; alt?: string }) => {
      if (!src) return null;
      return (
        <div className="relative h-28 w-full flex-shrink-0 overflow-hidden rounded-t-xl bg-gray-100">
          <CmsMediaImg src={src} alt={alt || ''} className="absolute inset-0 h-full w-full object-fill" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        </div>
      );
    };

    const Avatar = ({ src, name }: { src?: string; name?: string }) => (
      <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center overflow-hidden flex-shrink-0">
        {src ? (
          <CmsMediaImg src={src} alt={name || ''} className="w-full h-full object-fill" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        ) : (
          <span className="text-sm">{(name || '?')[0]}</span>
        )}
      </div>
    );

    const renderCardBody = (item: any) => {
      switch (activeTab) {
        case 'banners':
          return (<><Thumb src={item.url} alt={item.alt} /><div className="p-3 space-y-2 flex-1">{item.title && <p className="text-sm text-gray-800">{item.title}</p>}<Field label={ct("headers.altText", "描述", "Alt")} value={item.alt} /><Field label={ct("headers.content", "内容", "Content")} value={item.content} /><Field label="URL" value={item.url} mono /><Field label={ct("headers.videoUrl", "视频URL", "Video URL")} value={item.videoUrl} mono /></div></>);
        case 'live':
          return (<><Thumb src={item.thumbnail} alt={item.title} /><div className="p-3 space-y-2 flex-1"><p className="text-sm text-gray-800">{item.title || '-'}</p><div className="flex items-center gap-2"><span className="inline-flex items-center gap-1 text-[11px] bg-red-50 text-red-600 px-2 py-0.5 rounded-full">● LIVE</span><span className="text-xs text-gray-500">{item.viewers || 0} {ct("commonLabels.viewers", "观看", "viewers")}</span></div><Field label="URL" value={item.videoUrl} mono /></div></>);
        case 'articles':
          return (<><Thumb src={item.thumbnail} alt={item.title} /><div className="p-3 space-y-2 flex-1"><p className="text-sm text-gray-800">{item.title || '-'}</p><Field label={ct("headers.content", "内容", "Content")} value={item.content} /><Field label={ct("headers.videoUrl", "视频URL", "Video URL")} value={item.videoUrl} mono /></div></>);
        case 'marketCategories':
          return (<div className="p-3 space-y-2 flex-1"><p className="text-sm text-gray-800">{item.name || '-'}</p>{item.subCategories?.length > 0 && <div className="flex flex-wrap gap-1">{item.subCategories.map((sub: string, i: number) => <span key={i} className="text-[11px] bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full">{sub}</span>)}</div>}</div>);
        case 'marketProducts':
          return (<><Thumb src={item.image} alt={item.name} /><div className="p-3 space-y-2 flex-1"><div className="flex items-start justify-between gap-2"><p className="text-sm text-gray-800 flex-1">{item.name || '-'}</p>{item.price && <span className="text-sm text-emerald-600 flex-shrink-0">{item.price}</span>}</div>{item.category && <span className="inline-block text-[11px] bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full">{item.category}</span>}<Field label={ct("commonLabels.desc", "描述", "Desc")} value={item.description} /><Field label={ct("headers.videoUrl", "视频URL", "Video URL")} value={item.videoUrl} mono /></div></>);
        case 'marketAd':
          return (<><Thumb src={item.image} alt={item.title} /><div className="p-3 space-y-2 flex-1"><p className="text-sm text-gray-800">{item.title || '-'}</p><Field label={ct("headers.content", "内容", "Content")} value={item.content} /></div></>);
        case 'filing':
          return (<div className="p-3 space-y-2 flex-1"><Field label={ct("messages.icp_number", "ICP备案号", "ICP Number")} value={item.icpNumber} mono /><Field label={ct("messages.icp_link", "ICP链接", "ICP Link")} value={item.icpUrl} mono /><Field label={ct("messages.police_filing", "公安备案号", "Police Filing")} value={item.policeNumber} mono /><Field label={ct("messages.police_link", "公安链接", "Police Link")} value={item.policeUrl} mono /></div>);
        case 'aboutUs': case 'privacy': case 'terms': case 'technicalSupport':
          return (<div className="p-3 space-y-2 flex-1"><p className="text-xs text-gray-600 whitespace-pre-wrap line-clamp-6">{item.content || '-'}</p></div>);
        case 'appBranding':
          return (<div className="p-3 flex items-center gap-3 flex-1">{item.logoUrl ? <CmsMediaImg src={item.logoUrl} alt="Logo" className="w-12 h-12 rounded-xl object-fill bg-gray-100 flex-shrink-0 border border-gray-200" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} /> : <div className="w-12 h-12 rounded-xl bg-emerald-100 flex items-center justify-center flex-shrink-0 text-lg">🌱</div>}<div className="min-w-0 flex-1 space-y-1"><p className="text-sm text-gray-800">{item.appName || '-'}</p><p className="text-xs text-gray-500 truncate">{item.slogan || '-'}</p></div></div>);
        case 'splashScreen':
          return (<div className="p-3 space-y-2 flex-1"><Field label={ct("messages.image_url", "背景图", "Image URL")} value={item.imageUrl} mono /><p className="text-[11px] text-gray-500">{ct("messages.min_ms", "最短展示", "Min ms")}: {item.minDisplayMs ?? 2000} · {ct("messages.max_wait_ms", "最长等待", "Max wait ms")}: {item.maxResourceWaitMs ?? 4000} · {item.showSkipButton !== false ? ct("messages.skip_on", "显示跳过", "Skip on") : ct("messages.skip_off", "隐藏跳过", "Skip off")}</p>{item.imageUrl ? <div className="flex justify-center bg-gray-100 rounded-lg border border-gray-200 max-h-36 overflow-hidden"><CmsMediaImg src={item.imageUrl} alt="" className="max-h-36 max-w-full w-auto object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} /></div> : null}</div>);
        case 'chatContact':
          return (<div className="p-3 flex-1 space-y-2"><div className="flex items-center gap-3"><Avatar src={item.avatar} name={item.name} /><div className="min-w-0 flex-1"><p className="text-sm text-gray-800">{item.name || '-'}</p><p className="text-xs text-gray-500 truncate">{item.subtitle || '-'}</p></div></div><div className="grid grid-cols-1 gap-x-3 gap-y-1 pt-1"><Field label={ct("messages.merchant_user_id", "商家账号ID", "Merchant User ID")} value={item.merchantUserId} mono /><Field label="Channel ID" value={item.channelId} mono /><Field label={ct("messages.verified_domains", "验证域名", "Verified Domains")} value={(item.verifiedDomains || []).join(', ')} mono /></div></div>);
        case 'desktopIcon':
          return (<div className="p-3 flex items-center gap-3 flex-1">{item.icon192Url ? <CmsMediaImg src={item.icon192Url} alt="Icon" className="w-12 h-12 rounded-xl object-fill bg-gray-100 flex-shrink-0 border border-gray-200" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} /> : <div className="w-12 h-12 rounded-xl bg-gray-100 flex-shrink-0" />}<div className="min-w-0 flex-1 space-y-1"><p className="text-sm text-gray-800">{item.appName || '-'}</p><Field label="192px" value={item.icon192Url} mono /><Field label="512px" value={item.icon512Url} mono /></div></div>);
        default:
          return (<div className="p-3 flex-1"><pre className="text-xs text-gray-600 whitespace-pre-wrap break-all">{JSON.stringify(item, null, 2).slice(0, 200)}</pre></div>);
      }
    };

    return (
      <SortableList
        items={items}
        onReorder={(newItems) => {
          const newConfig = JSON.parse(JSON.stringify(workingConfig)) as typeof config;
          switch (activeTab) {
            case "banners": newConfig.banners = newItems; break;
            case "live": newConfig.liveStreams = newItems; break;
            case "articles": newConfig.articles = newItems; break;
            case "marketCategories":
              ensureMarketPageOnConfig(newConfig as unknown as Record<string, unknown>);
              newConfig.marketPage!.categories = newItems;
              break;
            case "marketProducts":
              ensureMarketPageOnConfig(newConfig as unknown as Record<string, unknown>);
              newConfig.marketPage!.products = newItems;
              break;
            case "marketAd":
              ensureMarketPageOnConfig(newConfig as unknown as Record<string, unknown>);
              newConfig.marketPage!.advertisements = newItems;
              break;
          }
          setWorkingConfig(newConfig);
          setHasChanges(true);
        }}
        itemKey={(item, idx) => `${activeTab}-${String(item.id ?? 'noid')}-${idx}`}
        showHandle={false}
        className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3"
        renderItem={(item: any) => (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden flex flex-col hover:shadow-md hover:border-emerald-200 transition-all group cursor-grab active:cursor-grabbing">
            {renderCardBody(item)}
            <div className="border-t border-gray-100 px-3 py-2 flex items-center justify-between bg-gray-50/60">
              <button onClick={(e) => { e.stopPropagation(); setEditingItem({ ...item }); }} className="flex items-center gap-1.5 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 px-2.5 py-1.5 rounded-lg transition-colors">
                <Edit3 className="w-3.5 h-3.5" />{ct("buttons.edit", "编辑", "Edit")}
              </button>
              <button onClick={(e) => { e.stopPropagation(); handleDeleteItem(item.id); }} className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-600 hover:bg-red-50 px-2.5 py-1.5 rounded-lg transition-colors">
                <Trash2 className="w-3.5 h-3.5" />{ct("buttons.delete", "删除", "Delete")}
              </button>
            </div>
          </div>
        )}
      />
    );
  };

  // 获取表头
  const getTableHeaders = () => {
    switch (activeTab) {
      case "banners":
        return ["ID", ct("headers.imageUrl", "图片URL", "Image URL"), ct("headers.altText", "描述文字", "Alt Text"), ct("headers.title", "标题", "Title"), ct("headers.content", "内容", "Content"), ct("headers.videoUrl", "视频URL", "Video URL")];
      case "live":
        return ["ID", ct("headers.liveTitle", "直播标题", "Live Title"), ct("headers.viewers", "观看人数", "Viewers"), ct("headers.videoUrl", "视频URL", "Video URL"), ct("headers.preview", "预览", "Preview")];
      case "articles":
        return ["ID", ct("headers.articleTitle", "文章标题", "Article Title"), ct("headers.content", "内容", "Content"), ct("headers.thumbnailUrl", "缩略图URL", "Thumbnail URL"), ct("headers.videoUrl", "视频URL", "Video URL")];
      case "marketCategories":
        return ["ID", ct("headers.categoryName", "类别名称", "Category Name"), ct("headers.subcategories", "子类别", "Subcategories")];
      case "marketProducts":
        return ["ID", ct("headers.productName", "产品名称", "Product Name"), ct("headers.description", "描述", "Description"), ct("headers.price", "价格", "Price"), ct("headers.category", "类别", "Category"), ct("headers.thumbnailUrl", "缩略图URL", "Thumbnail URL"), ct("headers.videoUrl", "视频URL", "Video URL")];
      case "marketAd":
        return ["ID", ct("headers.adTitle", "广告标题", "Ad Title"), ct("headers.content", "内容", "Content"), ct("headers.thumbnailUrl", "缩略图URL", "Thumbnail URL")];
      case "filing":
        return [ct("messages.icp_number", "ICP备案号", "ICP Number"), ct("messages.icp_link", "ICP链接", "ICP Link"), ct("messages.police_filing_no", "公安备案号", "Police Filing No."), ct("messages.police_link", "公安链接", "Police Link")];
      case "aboutUs":
        return ["ID", ct("messages.about_us_content", "关于我们内容", "About Us Content")];
      case "privacy":
        return ["ID", ct("messages.privacy_policy_content", "隐私政策内容", "Privacy Policy Content")];
      case "terms":
        return ["ID", ct("messages.terms_of_service_content", "服务条款内容", "Terms of Service Content")];
      case "technicalSupport":
        return [ct("headers.title", "标题", "Title"), ct("messages.technical_support_company_info", "技术支持内容", "Technical support / company info")];
      case "appBranding":
        return [ct("messages.logo_icon", "Logo图标", "Logo Icon"), ct("messages.app_name", "应用名称", "App Name"), ct("messages.slogan", "口号", "Slogan")];
      case "splashScreen":
        return [ct("messages.splash_image_url", "背景图URL", "Splash image URL"), ct("messages.min_ms_1", "最短(ms)", "Min ms"), ct("messages.max_wait_ms_1", "最长等待(ms)", "Max wait ms"), ct("messages.skip", "跳过", "Skip")];
      case "chatContact":
        return [ct("messages.merchant_user_id", "商家账号ID", "Merchant User ID"), ct("messages.channel_id", "聊天室ID", "Channel ID"), ct("messages.cached_name", "名称缓存", "Cached Name"), ct("messages.cached_subtitle", "副标题缓存", "Cached Subtitle"), ct("messages.verified_domains", "验证域名", "Verified Domains")];
      case "desktopIcon":
        return [ct("messages.app_name", "应用名称", "App Name"), ct("messages.icon_192", "192px图标", "Icon 192"), ct("messages.icon_512", "512px图标", "Icon 512")];
      case "aiModel":
        return ["ID", ct("messages.model_name", "模型名称", "Model Name"), ct("headers.description", "描述", "Description"), ct("messages.parameters", "参数", "Parameters")];
      default:
        return [];
    }
  };

  // 渲染表格行
  const renderTableRow = (item: any) => {
    switch (activeTab) {
      case "banners":
        return (
          <>
            <td className="px-3 py-2 text-xs">{item.id}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.url}>{item.url}</td>
            <td className="px-3 py-2 text-xs">{item.alt}</td>
            <td className="px-3 py-2 text-xs">{item.title}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.content}>{item.content}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.videoUrl}>{item.videoUrl || <span className="text-gray-400">-</span>}</td>
          </>
        );
      case "live":
        return (
          <>
            <td className="px-3 py-2 text-xs">{item.id}</td>
            <td className="px-3 py-2 text-xs">{item.title}</td>
            <td className="px-3 py-2 text-xs">{item.viewers}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.videoUrl}>{item.videoUrl || <span className="text-gray-400">-</span>}</td>
            <td className="px-3 py-2 text-xs">
              {item.thumbnail ? (
                <CmsMediaImg src={item.thumbnail} alt={item.title} className="w-16 h-10 object-fill bg-gray-100 rounded" />
              ) : (
                <span className="text-gray-400">{ct("commonLabels.noThumbnail", "无缩略图", "No thumbnail")}</span>
              )}
            </td>
          </>
        );
      case "articles":
        return (
          <>
            <td className="px-3 py-2 text-xs">{item.id}</td>
            <td className="px-3 py-2 text-xs">{item.title}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.content}>{item.content}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.thumbnail}>{item.thumbnail}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.videoUrl}>{item.videoUrl || <span className="text-gray-400">-</span>}</td>
          </>
        );
      case "marketCategories":
        return (
          <>
            <td className="px-3 py-2 text-xs">{item.id}</td>
            <td className="px-3 py-2 text-xs">{item.name}</td>
            <td className="px-3 py-2 text-xs">{item.subCategories.join(", ")}</td>
          </>
        );
      case "marketProducts":
        return (
          <>
            <td className="px-3 py-2 text-xs">{item.id}</td>
            <td className="px-3 py-2 text-xs">{item.name}</td>
            <td className="px-3 py-2 text-xs">{item.description}</td>
            <td className="px-3 py-2 text-xs">{item.price}</td>
            <td className="px-3 py-2 text-xs">{item.category}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.image}>{item.image}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.videoUrl}>{item.videoUrl || <span className="text-gray-400">-</span>}</td>
          </>
        );
      case "marketAd":
        return (
          <>
            <td className="px-3 py-2 text-xs">{item.id}</td>
            <td className="px-3 py-2 text-xs">{item.title}</td>
            <td className="px-3 py-2 text-xs">{item.content || "-"}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.image}>{item.image}</td>
          </>
        );
      case "filing":
        return (
          <>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.icpNumber}>{item.icpNumber}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.icpUrl}>{item.icpUrl}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.policeNumber}>{item.policeNumber}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.policeUrl}>{item.policeUrl}</td>
          </>
        );
      case "aboutUs":
        return (
          <>
            <td className="px-3 py-2 text-xs">{item.id}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.content}>{item.content}</td>
          </>
        );
      case "privacy":
        return (
          <>
            <td className="px-3 py-2 text-xs">{item.id}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.content}>{item.content}</td>
          </>
        );
      case "terms":
        return (
          <>
            <td className="px-3 py-2 text-xs">{item.id}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.content}>{item.content}</td>
          </>
        );
      case "technicalSupport":
        return (
          <>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.title}>{item.title || '-'}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.content}>{item.content || '-'}</td>
          </>
        );
      case "appBranding":
        return (
          <>
            <td className="px-3 py-2 text-xs">{item.logoUrl}</td>
            <td className="px-3 py-2 text-xs">{item.appName}</td>
            <td className="px-3 py-2 text-xs">{item.slogan}</td>
          </>
        );
      case "splashScreen":
        return (
          <>
            <td className="px-3 py-2 text-xs max-w-[140px] truncate" title={item.imageUrl}>{item.imageUrl || '-'}</td>
            <td className="px-3 py-2 text-xs">{item.minDisplayMs ?? 2000}</td>
            <td className="px-3 py-2 text-xs">{item.maxResourceWaitMs ?? 4000}</td>
            <td className="px-3 py-2 text-xs">{item.showSkipButton !== false ? '✓' : '—'}</td>
          </>
        );
      case "chatContact":
        return (
          <>
            <td className="px-3 py-2 text-xs font-mono">{item.merchantUserId || "-"}</td>
            <td className="px-3 py-2 text-xs font-mono">{item.channelId || "-"}</td>
            <td className="px-3 py-2 text-xs">{item.name || "-"}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.subtitle}>{item.subtitle || "-"}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={(item.verifiedDomains || []).join(", ")}>{(item.verifiedDomains || []).join(", ") || "-"}</td>
          </>
        );
      case "desktopIcon":
        return (
          <>
            <td className="px-3 py-2 text-xs">{item.appName}</td>
            <td className="px-3 py-2 text-xs max-w-[120px] truncate" title={item.icon192Url}>{item.icon192Url}</td>
            <td className="px-3 py-2 text-xs max-w-[120px] truncate" title={item.icon512Url}>{item.icon512Url}</td>
          </>
        );
      case "aiModel":
        return (
          <>
            <td className="px-3 py-2 text-xs">{item.id}</td>
            <td className="px-3 py-2 text-xs">{item.name}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.description}>{item.description}</td>
            <td className="px-3 py-2 text-xs max-w-xs truncate" title={item.parameters}>{item.parameters}</td>
          </>
        );
      default:
        return null;
    }
  };

  // 渲染编辑对话框
  const renderEditDialog = () => {
    if (!editingItem) return null;

    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-xl max-w-2xl w-full max-h-[90vh] flex flex-col min-h-0 overflow-hidden shadow-xl">
          <div className="shrink-0 bg-emerald-600 text-white px-6 py-4 flex justify-between items-center">
            <h3 className="text-lg font-semibold">{ct("buttons.edit", "编辑", "Edit")} {getTabName(activeTab)}</h3>
            <button onClick={() => setEditingItem(null)} className="text-white hover:bg-emerald-700 rounded-lg p-1">
              ✕
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-6 space-y-4">
            {renderEditFields()}
          </div>

          <div className="shrink-0 bg-gray-50 px-6 py-4 flex gap-3 justify-end border-t">
            <button
              onClick={() => setEditingItem(null)}
              className="px-6 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
            >
              {ct("buttons.cancel", "取消", "Cancel")}
            </button>
            <button
              onClick={handleSaveEdit}
              className="px-6 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors flex items-center gap-2"
            >
              <Save className="w-4 h-4" />
              {ct("buttons.save", "保存", "Save")}
            </button>
          </div>
        </div>
      </div>
    );
  };

  // 渲染编辑字段
  const renderEditFields = () => {
    switch (activeTab) {
      case "banners":
        return (
          <>
            <InputField label="ID" value={editingItem.id} disabled />
            <CmsStorageUploadRow
              label={ct("headers.imageUrl", "图片URL", "Image URL")}
              value={editingItem.url || ""}
              onChange={(v: string) => setEditingItem({ ...editingItem, url: v })}
              mode="image"
            />
            {editingItem.url && (
              <div className="mt-2">
                <p className="text-xs text-gray-500 mb-1">{ct("messages.preview_resized_config_stores_original_url", "预览（按需缩小，配置存原链）", "Preview (resized; config stores original URL)")}</p>
                <div className="relative max-w-md w-full aspect-[2/1] overflow-hidden rounded-lg border border-gray-200 bg-gray-100">
                  <CmsMediaImg src={editingItem.url} alt={ct("messages.banner_preview", "轮播预览", "Banner preview")} className="absolute inset-0 h-full w-full object-fill" />
                </div>
              </div>
            )}
            <InputField label={ct("headers.altText", "描述文字", "Alt Text")} value={editingItem.alt} onChange={(v: string) => setEditingItem({ ...editingItem, alt: v })} />
            <InputField label={ct("headers.title", "标题", "Title")} value={editingItem.title} onChange={(v: string) => setEditingItem({ ...editingItem, title: v })} />
            <CmsStorageUploadRow
              label={ct("messages.detail_video_url_optional", "详情页视频URL（可选）", "Detail video URL (optional)")}
              value={editingItem.videoUrl || ""}
              onChange={(v: string) => setEditingItem({ ...editingItem, videoUrl: v })}
              mode="video"
            />
            <p className="text-xs text-gray-500">{ct("messages.live_video_url_supports_embed", "支持直链视频（MP4 等），或 YouTube / Vimeo / B 站 / Facebook 分享链接", "Supports direct video URLs (MP4, etc.) or YouTube / Vimeo / Bilibili / Facebook share links")}</p>
            <CmsVideoUrlEmbedPreview videoUrl={editingItem.videoUrl} ct={ct} />
            <RichTextEditor label={ct("headers.content", "内容", "Content")} value={editingItem.content || ""} onChange={(v: string) => setEditingItem({ ...editingItem, content: v })} placeholder={ct("messages.paste_from_word_or_edit_directly_supports_formatting", "从Word粘贴或直接编辑，支持格式和图片", "Paste from Word or edit directly, supports formatting and images")} />
          </>
        );
      case "live":
        return (
          <>
            <InputField label="ID" value={editingItem.id} disabled />
            <InputField label={ct("headers.liveTitle", "直播标题", "Live Title")} value={editingItem.title} onChange={(v: string) => setEditingItem({ ...editingItem, title: v })} />
            <InputField label={ct("headers.viewers", "观看人数", "Viewers")} value={editingItem.viewers} onChange={(v: string) => setEditingItem({ ...editingItem, viewers: v })} />
            <CmsStorageUploadRow
              label={ct("headers.thumbnailUrl", "缩略图URL", "Thumbnail URL")}
              value={editingItem.thumbnail || ""}
              onChange={(v: string) => setEditingItem({ ...editingItem, thumbnail: v })}
              mode="image"
            />
            {editingItem.thumbnail && (
              <CmsMediaImg src={editingItem.thumbnail} alt={ct("messages.thumbnail_preview", "缩略图预览", "Thumbnail preview")} className="mt-2 w-full max-w-xs h-32 object-fill bg-gray-100 rounded-lg border border-gray-200" />
            )}
            <CmsStorageUploadRow
              label={ct("headers.videoUrl", "视频URL", "Video URL")}
              value={editingItem.videoUrl || ""}
              onChange={(v: string) => setEditingItem({ ...editingItem, videoUrl: v })}
              mode="video"
            />
            <p className="text-xs text-gray-500">{ct("messages.live_video_url_supports_embed", "支持直链视频（MP4 等），或 YouTube / Vimeo / B 站 / Facebook 分享链接", "Supports direct video URLs (MP4, etc.) or YouTube / Vimeo / Bilibili / Facebook share links")}</p>
            <CmsVideoUrlEmbedPreview videoUrl={editingItem.videoUrl} ct={ct} hintVariant="live" />

            {/* ── 分享设置 (Per-video) ── */}
            <div className="border-t border-gray-200 pt-4 mt-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-md bg-blue-100 text-blue-700 flex items-center justify-center text-xs">S</span>
                  <h4 className="text-sm text-gray-800">{ct("messages.share_settings", "分享设置", "Share Settings")}</h4>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" checked={editingItem.shareEnabled ?? false} onChange={(e) => setEditingItem({ ...editingItem, shareEnabled: e.target.checked })} className="sr-only peer" />
                  <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
                </label>
              </div>
              {editingItem.shareEnabled && (
                <div className="space-y-3 pl-2 border-l-2 border-blue-200">
                  <InputField label={ct("messages.share_url", "分享链接", "Share URL")} value={editingItem.shareUrl || ""} onChange={(v: string) => setEditingItem({ ...editingItem, shareUrl: v })} placeholder={ct("messages.leave_empty_for_current_domain", "留空自动取当前域名", "Leave empty for current domain")} />
                  <InputField label={ct("messages.share_title", "分享标题", "Share Title")} value={editingItem.shareTitle || ""} onChange={(v: string) => setEditingItem({ ...editingItem, shareTitle: v })} />
                  <InputField label={ct("messages.share_text", "分享描述", "Share Text")} value={editingItem.shareText || ""} onChange={(v: string) => setEditingItem({ ...editingItem, shareText: v })} />
                  <CmsStorageUploadRow label={ct("messages.share_image_url", "分享缩略图URL", "Share Image URL")} value={editingItem.shareImgUrl || ""} onChange={(v: string) => setEditingItem({ ...editingItem, shareImgUrl: v })} mode="image" />
                  <div className="mt-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={editingItem.wxJsSdkEnabled ?? false} onChange={(e) => setEditingItem({ ...editingItem, wxJsSdkEnabled: e.target.checked })} className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500" />
                      <span className="text-sm text-gray-700">{ct("messages.enable_wechat_js_sdk_share", "启用微信JS-SDK分享", "Enable WeChat JS-SDK Share")}</span>
                    </label>
                    {editingItem.wxJsSdkEnabled && (
                      <div className="mt-2 space-y-2 pl-4">
                        <InputField label={ct("messages.wechat_appid", "微信AppID", "WeChat AppID")} value={editingItem.wxAppId || ""} onChange={(v: string) => setEditingItem({ ...editingItem, wxAppId: v })} />
                        <InputField label={ct("messages.signature_api_url", "签名接口URL", "Signature API URL")} value={editingItem.wxSignatureApi || ""} onChange={(v: string) => setEditingItem({ ...editingItem, wxSignatureApi: v })} placeholder="https://api.example.com/wx-signature" />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* ── 导航设置 (Per-video) ── */}
            <div className="border-t border-gray-200 pt-4 mt-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-md bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs">N</span>
                  <h4 className="text-sm text-gray-800">{ct("messages.navigation_settings", "导航设置", "Navigation Settings")}</h4>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" checked={editingItem.navEnabled ?? false} onChange={(e) => {
                    const updates: any = { ...editingItem, navEnabled: e.target.checked };
                    if (e.target.checked && !editingItem.navCreatedAt) {
                      updates.navCreatedAt = Date.now();
                    }
                    setEditingItem(updates);
                  }} className="sr-only peer" />
                  <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
                </label>
              </div>
              {editingItem.navEnabled && (
                <div className="space-y-3 pl-2 border-l-2 border-emerald-200">
                  <div className="grid grid-cols-2 gap-3">
                    <InputField label={ct("messages.latitude", "纬度", "Latitude")} value={editingItem.navLatitude || ""} onChange={(v: string) => setEditingItem({ ...editingItem, navLatitude: v })} placeholder="39.9042" />
                    <InputField label={ct("messages.longitude", "经度", "Longitude")} value={editingItem.navLongitude || ""} onChange={(v: string) => setEditingItem({ ...editingItem, navLongitude: v })} placeholder="116.4074" />
                  </div>
                  <InputField label={ct("messages.address_name", "地址名称", "Address Name")} value={editingItem.navAddress || ""} onChange={(v: string) => setEditingItem({ ...editingItem, navAddress: v })} placeholder={ct("messages.e_g_1_zhongguancun_st_haidian_beijing", "例如：北京市海淀区中关村大街1号", "e.g. 1 Zhongguancun St, Haidian, Beijing")} />
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{ct("messages.navigation_button_display_days", "导航按钮显示天数", "Navigation Button Display Days")}</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="1"
                        max="365"
                        value={editingItem.navDisplayDays ?? 15}
                        onChange={(e) => setEditingItem({ ...editingItem, navDisplayDays: parseInt(e.target.value) || 15 })}
                        className="w-24 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm"
                      />
                      <span className="text-sm text-gray-500">{ct("messages.days", "天", "days")}</span>
                    </div>
                    <p className="mt-1 text-xs text-gray-400">{ct("messages.navigation_button_auto_hides_after_specified_days_default", "超过指定天数后，导航按钮将自动隐藏（默认15天）", "Navigation button auto-hides after specified days (default 15)")}</p>
                    {editingItem.navCreatedAt && (
                      <p className="mt-1 text-xs text-emerald-600">{ct("messages.navigation_enabled_on", "导航启用于：", "Navigation enabled on: ")}{new Date(editingItem.navCreatedAt).toLocaleDateString()}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">{ct("messages.input_coordinate_system", "输入坐标系", "Input Coordinate System")}</label>
                    <div className="flex gap-2">
                      {[
                        { value: "wgs84", label: "WGS84", hint: ct("messages.gps_raw", "GPS原始", "GPS Raw") },
                        { value: "gcj02", label: "GCJ02", hint: ct("messages.china_amap", "国测局/高德", "China/Amap") },
                        { value: "bd09", label: "BD09", hint: ct("messages.baidu", "百度", "Baidu") },
                      ].map((cs) => (
                        <button
                          key={cs.value}
                          type="button"
                          onClick={() => setEditingItem({ ...editingItem, navCoordSystem: cs.value })}
                          className={`flex-1 py-2 px-2 rounded-lg border text-center transition-colors ${
                            (editingItem.navCoordSystem || "wgs84") === cs.value
                              ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                              : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                          }`}
                        >
                          <p className="text-xs font-medium">{cs.label}</p>
                          <p className="text-[10px] text-gray-400 mt-0.5">{cs.hint}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-gray-600 mb-2">{ct("messages.enabled_map_apps", "启用的地图应用", "Enabled Map Apps")}</p>
                    <div className="space-y-2">
                      {[
                        { key: "navBaiduMap", label: ct("messages.baidu_maps", "百度地图", "Baidu Maps"), hint: ct("messages.china", "中国区", "China"), icon: "M" },
                        { key: "navAmapMap", label: ct("messages.amap_gaode", "高德地图", "Amap / Gaode"), hint: ct("messages.china", "中国区", "China"), icon: "A" },
                        { key: "navGoogleMap", label: "Google Maps", hint: ct("messages.intl", "国际", "Intl"), icon: "G" },
                        { key: "navAppleMaps", label: "Apple Maps", hint: ct("messages.intl", "国际", "Intl"), icon: "A" },
                        { key: "navWaze", label: "Waze", hint: ct("messages.intl", "国际", "Intl"), icon: "W" },
                      ].map((app) => (
                        <label key={app.key} className="flex items-center justify-between py-1.5 cursor-pointer">
                          <div className="flex items-center gap-2">
                            <span className="w-5 h-5 rounded bg-gray-100 text-gray-600 flex items-center justify-center text-[10px]">{app.icon}</span>
                            <span className="text-sm text-gray-800">{app.label}</span>
                            <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">{app.hint}</span>
                          </div>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" checked={(editingItem as any)[app.key] ?? true} onChange={(e) => setEditingItem({ ...editingItem, [app.key]: e.target.checked })} className="sr-only peer" />
                            <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
                          </label>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        );
      case "articles":
        return (
          <>
            <InputField label="ID" value={editingItem.id} disabled />
            <InputField label={ct("headers.articleTitle", "文章标题", "Article Title")} value={editingItem.title} onChange={(v: string) => setEditingItem({ ...editingItem, title: v })} />
            <RichTextEditor label={ct("messages.article_content", "文章内容", "Article Content")} value={editingItem.content || ""} onChange={(v: string) => setEditingItem({ ...editingItem, content: v })} placeholder={ct("messages.paste_text_lists_from_word_use_toolbar_to", "从 Word 粘贴文字与列表；插图请用工具栏上传至云端（不再内嵌大图）", "Paste text/lists from Word; use toolbar to upload images to cloud (no embedded large images)")} minHeight="300px" />
            <CmsStorageUploadRow label={ct("headers.thumbnailUrl", "缩略图URL", "Thumbnail URL")} value={editingItem.thumbnail || ""} onChange={(v: string) => setEditingItem({ ...editingItem, thumbnail: v })} mode="image" />
            {editingItem.thumbnail && (
              <div className="mt-2">
                <p className="text-xs text-gray-500 mb-1">{ct("messages.thumbnail_preview", "缩略图预览", "Thumbnail preview")}</p>
                <CmsMediaImg src={editingItem.thumbnail} alt="" className="w-24 h-24 object-fill bg-gray-100 rounded-lg border border-gray-200" />
              </div>
            )}
            <CmsStorageUploadRow
              label={ct("messages.detail_video_url_optional", "详情页视频URL（可选）", "Detail video URL (optional)")}
              value={editingItem.videoUrl || ""}
              onChange={(v: string) => setEditingItem({ ...editingItem, videoUrl: v })}
              mode="video"
            />
            <p className="text-xs text-gray-500">{ct("messages.live_video_url_supports_embed", "支持直链视频（MP4 等），或 YouTube / Vimeo / B 站 / Facebook 分享链接", "Supports direct video URLs (MP4, etc.) or YouTube / Vimeo / Bilibili / Facebook share links")}</p>
            <CmsVideoUrlEmbedPreview videoUrl={editingItem.videoUrl} ct={ct} />
          </>
        );
      case "marketCategories":
        return (
          <>
            <InputField 
              label={ct("messages.category_id_english_for_system_use", "类别ID（英文，用于系统识别）", "Category ID (English, for system use)")} 
              value={editingItem.id} 
              onChange={(v: string) => setEditingItem({ ...editingItem, id: v })} 
              placeholder={ct("messages.e_g_herbicide_insecticide", "例如：herbicide, insecticide", "e.g. herbicide, insecticide")}
            />
            <InputField 
              label={ct("messages.category_name_displayed_to_user", "类别名称（显示给用户）", "Category Name (displayed to user)")} 
              value={editingItem.name} 
              onChange={(v: string) => setEditingItem({ ...editingItem, name: v })} 
              placeholder={ct("messages.e_g_herbicide_insecticide_1", "例如：除草剂, 杀虫剂", "e.g. Herbicide, Insecticide")}
            />
            
            {/* 子类别编辑 */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {ct("messages.subcategory_list", "子类别列表", "Subcategory List")}
              </label>
              <div className="space-y-2">
                {(editingItem.subCategories || []).map((subCat: string, index: number) => (
                  <div key={index} className="flex gap-2">
                    <input
                      type="text"
                      value={subCat}
                      onChange={(e) => {
                        const newSubCategories = [...(editingItem.subCategories || [])];
                        newSubCategories[index] = e.target.value;
                        setEditingItem({ ...editingItem, subCategories: newSubCategories });
                      }}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      placeholder={ct("messages.subcategory_name", "子类别名称", "Subcategory name")}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const newSubCategories = editingItem.subCategories.filter((_: string, i: number) => i !== index);
                        setEditingItem({ ...editingItem, subCategories: newSubCategories });
                      }}
                      className="px-3 py-2 bg-red-100 text-red-600 rounded-lg hover:bg-red-200 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                
                {/* 添加子类别按钮 */}
                <button
                  type="button"
                  onClick={() => {
                    const newSubCategories = [...(editingItem.subCategories || []), ""];
                    setEditingItem({ ...editingItem, subCategories: newSubCategories });
                  }}
                  className="w-full px-3 py-2 bg-emerald-50 text-emerald-600 border-2 border-dashed border-emerald-300 rounded-lg hover:bg-emerald-100 transition-colors flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  {ct("buttons.addSubcategory", "添加子类别", "Add Subcategory")}
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {ct("messages.examples_pre_emergence_mid_post_pre_post", "💡 子类别示例：苗前、苗中后、苗前苗后", "💡 Examples: Pre-emergence, Mid-post, Pre & Post")}
              </p>
            </div>
          </>
        );
      case "marketProducts":
        return (
          <>
            <InputField label="ID" value={editingItem.id} disabled />
            <InputField label={ct("headers.productName", "产品名称", "Product Name")} value={editingItem.name} onChange={(v: string) => setEditingItem({ ...editingItem, name: v })} />
            
            {/* 一级类别选择 */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">{ct("messages.primary_category", "一级类别", "Primary Category")}</label>
              <select
                value={editingItem.category || ""}
                onChange={(e) => setEditingItem({ ...editingItem, category: e.target.value, subCategory: "" })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="">{ct("messages.select_category", "选择类别", "Select category")}</option>
                {(workingConfig.marketPage?.categories || []).map((cat) => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
              </select>
            </div>

            {/* 二级类别选择 */}
            {editingItem.category && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">{ct("messages.subcategory", "二级类别", "Subcategory")}</label>
                <select
                  value={editingItem.subCategory || ""}
                  onChange={(e) => setEditingItem({ ...editingItem, subCategory: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="">{ct("messages.select_subcategory", "选择子类别", "Select subcategory")}</option>
                  {(workingConfig.marketPage?.categories || [])
                    .find((cat) => cat.id === editingItem.category)
                    ?.subCategories.map((subCat) => (
                      <option key={subCat} value={subCat}>{subCat}</option>
                    ))}
                </select>
              </div>
            )}
            
            <InputField label={ct("headers.price", "价格", "Price")} value={editingItem.price} onChange={(v: string) => setEditingItem({ ...editingItem, price: v })} placeholder={ct("messages.e_g_68", "例如：¥68", "e.g. 68")} />
            <InputField label={ct("messages.stock_qty", "库存数量", "Stock Qty")} value={editingItem.stock || ""} onChange={(v: string) => setEditingItem({ ...editingItem, stock: parseInt(v) || 0 })} type="number" />
            <CmsStorageUploadRow label={ct("messages.product_image_url", "产品图片URL", "Product Image URL")} value={editingItem.image || ""} onChange={(v: string) => setEditingItem({ ...editingItem, image: v })} mode="image" />
            {editingItem.image && (
              <div className="mt-2">
                <p className="text-xs text-gray-500 mb-1">{ct("messages.product_image_preview", "产品图预览", "Product image preview")}</p>
                <CmsMediaImg src={editingItem.image} alt="" className="w-full max-w-xs aspect-square object-fill bg-gray-100 rounded-lg border border-gray-200" />
              </div>
            )}
            <CmsStorageUploadRow
              label={ct("messages.detail_video_url_optional", "详情页视频URL（可选）", "Detail video URL (optional)")}
              value={editingItem.videoUrl || ""}
              onChange={(v: string) => setEditingItem({ ...editingItem, videoUrl: v })}
              mode="video"
            />
            <p className="text-xs text-gray-500">{ct("messages.live_video_url_supports_embed", "支持直链视频（MP4 等），或 YouTube / Vimeo / B 站 / Facebook 分享链接", "Supports direct video URLs (MP4, etc.) or YouTube / Vimeo / Bilibili / Facebook share links")}</p>
            <CmsVideoUrlEmbedPreview videoUrl={editingItem.videoUrl} ct={ct} />
            <TextAreaField label={ct("messages.short_description", "简短描述", "Short Description")} value={editingItem.description || ""} onChange={(v: string) => setEditingItem({ ...editingItem, description: v })} rows={2} placeholder={ct("messages.one_line_product_highlight", "一句话描述产品特点", "One-line product highlight")} />
            <RichTextEditor label={ct("messages.detailed_description", "详细说明", "Detailed Description")} value={editingItem.details || ""} onChange={(v: string) => setEditingItem({ ...editingItem, details: v })} placeholder={ct("messages.paste_from_word_or_edit_product_details", "从Word粘贴或直接编辑产品详情", "Paste from Word or edit product details")} minHeight="200px" />
            <RichTextEditor label={ct("messages.specifications", "产品规格", "Specifications")} value={editingItem.specifications || ""} onChange={(v: string) => setEditingItem({ ...editingItem, specifications: v })} placeholder={ct("messages.paste_from_word_or_edit_specifications", "从Word粘贴或直接编辑规格参数", "Paste from Word or edit specifications")} minHeight="150px" />
          </>
        );
      case "marketAd":
        return (
          <>
            <InputField label="ID" value={editingItem.id} disabled />
            <InputField label={ct("headers.adTitle", "广告标题", "Ad Title")} value={editingItem.title} onChange={(v: string) => setEditingItem({ ...editingItem, title: v })} />
            <RichTextEditor label={ct("messages.ad_content", "广告内容", "Ad Content")} value={editingItem.content || ""} onChange={(v: string) => setEditingItem({ ...editingItem, content: v })} placeholder={ct("messages.paste_from_word_or_edit_ad_details_directly", "从Word粘贴或直接编辑广告详情", "Paste from Word or edit ad details directly")} />
            <CmsStorageUploadRow label={ct("messages.ad_image_url", "广告图片URL", "Ad Image URL")} value={editingItem.image || ""} onChange={(v: string) => setEditingItem({ ...editingItem, image: v })} mode="image" />
            {editingItem.image && (
              <CmsMediaImg src={editingItem.image} alt={ct("messages.ad_preview", "广告预览", "Ad preview")} className="mt-2 w-full max-w-md h-40 object-fill bg-gray-100 rounded-lg border border-gray-200" />
            )}
          </>
        );
      case "market":
        // Dock 布局：根据 editingItem._type 分发到对应编辑表单
        if (editingItem?._type === "category") {
          return (
            <>
              <InputField label={ct("messages.category_id_english_for_system_use", "类别ID（英文，用于系统识别）", "Category ID (English, for system use)")} value={editingItem.id} onChange={(v: string) => setEditingItem({ ...editingItem, id: v })} placeholder={ct("messages.e_g_herbicide_insecticide", "例如：herbicide, insecticide", "e.g. herbicide, insecticide")} />
              <InputField label={ct("messages.category_name_displayed_to_user", "类别名称（显示给用户）", "Category Name (displayed to user)")} value={editingItem.name} onChange={(v: string) => setEditingItem({ ...editingItem, name: v })} placeholder={ct("messages.e_g_herbicide_insecticide_1", "例如：除草剂, 杀虫剂", "e.g. Herbicide, Insecticide")} />
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">{ct("messages.subcategory_list", "子类别列表", "Subcategory List")}</label>
                <div className="space-y-2">
                  {(editingItem.subCategories || []).map((subCat: string, index: number) => (
                    <div key={index} className="flex gap-2">
                      <input type="text" value={subCat} onChange={(e) => { const ns = [...(editingItem.subCategories || [])]; ns[index] = e.target.value; setEditingItem({ ...editingItem, subCategories: ns }); }} className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500" placeholder={ct("messages.subcategory_name", "子类别名称", "Subcategory name")} />
                      <button type="button" onClick={() => { const ns = editingItem.subCategories.filter((_: string, i: number) => i !== index); setEditingItem({ ...editingItem, subCategories: ns }); }} className="px-3 py-2 bg-red-100 text-red-600 rounded-lg hover:bg-red-200 transition-colors"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  ))}
                  <button type="button" onClick={() => { setEditingItem({ ...editingItem, subCategories: [...(editingItem.subCategories || []), ""] }); }} className="w-full px-3 py-2 bg-emerald-50 text-emerald-600 border-2 border-dashed border-emerald-300 rounded-lg hover:bg-emerald-100 transition-colors flex items-center justify-center gap-2"><Plus className="w-4 h-4" />{ct("buttons.addSubcategory", "添加子类别", "Add Subcategory")}</button>
                </div>
              </div>
            </>
          );
        }
        if (editingItem?._type === "ad") {
          return (
            <>
              <InputField label="ID" value={editingItem.id} disabled />
              <InputField label={ct("headers.adTitle", "广告标题", "Ad Title")} value={editingItem.title} onChange={(v: string) => setEditingItem({ ...editingItem, title: v })} />
              <RichTextEditor label={ct("messages.ad_content", "广告内容", "Ad Content")} value={editingItem.content || ""} onChange={(v: string) => setEditingItem({ ...editingItem, content: v })} placeholder={ct("messages.paste_from_word_or_edit_ad_details_directly", "从Word粘贴或直接编辑广告详情", "Paste from Word or edit ad details directly")} />
              <CmsStorageUploadRow label={ct("messages.ad_image_url", "广告图片URL", "Ad Image URL")} value={editingItem.image || ""} onChange={(v: string) => setEditingItem({ ...editingItem, image: v })} mode="image" />
              {editingItem.image && (<CmsMediaImg src={editingItem.image} alt={ct("messages.ad_preview", "广告预览", "Ad preview")} className="mt-2 w-full max-w-md h-40 object-fill bg-gray-100 rounded-lg border border-gray-200" />)}
            </>
          );
        }
        // 默认：产品
        return (
          <>
            <InputField label="ID" value={editingItem.id} disabled />
            <InputField label={ct("headers.productName", "产品名称", "Product Name")} value={editingItem.name} onChange={(v: string) => setEditingItem({ ...editingItem, name: v })} />
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">{ct("messages.primary_category", "一级类别", "Primary Category")}</label>
              <select value={editingItem.category || ""} onChange={(e) => setEditingItem({ ...editingItem, category: e.target.value, subCategory: "" })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500">
                <option value="">{ct("messages.select_category", "选择类别", "Select category")}</option>
                {(workingConfig.marketPage?.categories || []).map((cat: any) => (<option key={cat.id} value={cat.id}>{cat.name}</option>))}
              </select>
            </div>
            {editingItem.category && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">{ct("messages.subcategory", "二级类别", "Subcategory")}</label>
                <select value={editingItem.subCategory || ""} onChange={(e) => setEditingItem({ ...editingItem, subCategory: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500">
                  <option value="">{ct("messages.select_subcategory", "选择子类别", "Select subcategory")}</option>
                  {((workingConfig.marketPage?.categories || []).find((c: any) => c.id === editingItem.category)?.subCategories || []).map((sc: string) => (<option key={sc} value={sc}>{sc}</option>))}
                </select>
              </div>
            )}
            <InputField label={ct("headers.price", "价格", "Price")} value={editingItem.price} onChange={(v: string) => setEditingItem({ ...editingItem, price: v })} placeholder={ct("messages.e_g_68", "例如：¥68", "e.g. 68")} />
            <InputField label={ct("messages.stock_qty", "库存数量", "Stock Qty")} value={editingItem.stock || ""} onChange={(v: string) => setEditingItem({ ...editingItem, stock: parseInt(v) || 0 })} type="number" />
            <CmsStorageUploadRow label={ct("messages.product_image_url", "产品图片URL", "Product Image URL")} value={editingItem.image || ""} onChange={(v: string) => setEditingItem({ ...editingItem, image: v })} mode="image" />
            {editingItem.image && (<div className="mt-2"><p className="text-xs text-gray-500 mb-1">{ct("messages.product_image_preview", "产品图预览", "Product image preview")}</p><CmsMediaImg src={editingItem.image} alt="" className="w-full max-w-xs aspect-square object-fill bg-gray-100 rounded-lg border border-gray-200" /></div>)}
            <CmsStorageUploadRow label={ct("messages.detail_video_url_optional", "详情页视频URL（可选）", "Detail video URL (optional)")} value={editingItem.videoUrl || ""} onChange={(v: string) => setEditingItem({ ...editingItem, videoUrl: v })} mode="video" />
            <p className="text-xs text-gray-500">{ct("messages.live_video_url_supports_embed", "支持直链视频（MP4 等），或 YouTube / Vimeo / B 站 / Facebook 分享链接", "Supports direct video URLs (MP4, etc.) or YouTube / Vimeo / Bilibili / Facebook share links")}</p>
            <CmsVideoUrlEmbedPreview videoUrl={editingItem.videoUrl} ct={ct} />
            <TextAreaField label={ct("messages.short_description", "简短描述", "Short Description")} value={editingItem.description || ""} onChange={(v: string) => setEditingItem({ ...editingItem, description: v })} rows={2} placeholder={ct("messages.one_line_product_highlight", "一句话描述产品特点", "One-line product highlight")} />
            <RichTextEditor label={ct("messages.detailed_description", "详细说明", "Detailed Description")} value={editingItem.details || ""} onChange={(v: string) => setEditingItem({ ...editingItem, details: v })} placeholder={ct("messages.paste_from_word_or_edit_product_details", "从Word粘贴或直接编辑产品详情", "Paste from Word or edit product details")} minHeight="200px" />
            <RichTextEditor label={ct("messages.specifications", "产品规格", "Specifications")} value={editingItem.specifications || ""} onChange={(v: string) => setEditingItem({ ...editingItem, specifications: v })} placeholder={ct("messages.paste_from_word_or_edit_specifications", "从Word粘贴或直接编辑规格参数", "Paste from Word or edit specifications")} minHeight="150px" />
          </>
        );
      case "filing":
        return (
          <>
            <InputField label="ID" value={editingItem.id} disabled />
            <InputField label={ct("messages.icp_number", "ICP备案号", "ICP Number")} value={editingItem.icpNumber || ""} onChange={(v: string) => setEditingItem({ ...editingItem, icpNumber: v })} />
            <InputField label={ct("messages.icp_link", "ICP链接", "ICP Link")} value={editingItem.icpUrl || ""} onChange={(v: string) => setEditingItem({ ...editingItem, icpUrl: v })} />
            <InputField label={ct("messages.police_filing_no", "公安备案号", "Police Filing No.")} value={editingItem.policeNumber || ""} onChange={(v: string) => setEditingItem({ ...editingItem, policeNumber: v })} />
            <InputField label={ct("messages.police_link", "公安链接", "Police Link")} value={editingItem.policeUrl || ""} onChange={(v: string) => setEditingItem({ ...editingItem, policeUrl: v })} />
          </>
        );
      case "aboutUs":
        return (
          <>
            <InputField label="ID" value={editingItem.id} disabled />
            <RichTextEditor label={ct("messages.about_us_content", "关于我们内容", "About Us Content")} value={editingItem.content || ""} onChange={(v: string) => setEditingItem({ ...editingItem, content: v })} placeholder={ct("messages.paste_from_word_or_edit_directly", "从Word粘贴或直接编辑", "Paste from Word or edit directly")} />
          </>
        );
      case "privacy":
        return (
          <>
            <InputField label="ID" value={editingItem.id} disabled />
            <RichTextEditor label={ct("messages.privacy_policy_content", "隐私政策内容", "Privacy Policy Content")} value={editingItem.content || ""} onChange={(v: string) => setEditingItem({ ...editingItem, content: v })} placeholder={ct("messages.paste_from_word_or_edit_directly", "从Word粘贴或直接编辑", "Paste from Word or edit directly")} />
          </>
        );
      case "terms":
        return (
          <>
            <InputField label="ID" value={editingItem.id} disabled />
            <RichTextEditor label={ct("messages.terms_of_service_content", "服务条款内容", "Terms of Service Content")} value={editingItem.content || ""} onChange={(v: string) => setEditingItem({ ...editingItem, content: v })} placeholder={ct("messages.paste_from_word_or_edit_directly", "从Word粘贴或直接编辑", "Paste from Word or edit directly")} />
          </>
        );
      case "technicalSupport":
        return (
          <>
            <InputField label="ID" value={editingItem.id} disabled />
            <InputField label={ct("messages.page_title", "页面标题", "Page title")} value={editingItem.title || ""} onChange={(v: string) => setEditingItem({ ...editingItem, title: v })} />
            <RichTextEditor label={ct("messages.content_company_info_ads_contact_etc", "内容（公司介绍、广告、联系方式等）", "Content (company info, ads, contact, etc.)")} value={editingItem.content || ""} onChange={(v: string) => setEditingItem({ ...editingItem, content: v })} placeholder={ct("messages.paste_from_word_or_edit_directly", "从Word粘贴或直接编辑", "Paste from Word or edit directly")} />
          </>
        );
      case "appBranding":
        return (
          <>
            <CmsStorageUploadRow label={ct("messages.logo_icon", "Logo图标", "Logo Icon")} value={editingItem.logoUrl || ""} onChange={(v: string) => setEditingItem({ ...editingItem, logoUrl: v })} mode="image" />
            <InputField label={ct("messages.app_name", "应用名称", "App Name")} value={editingItem.appName || ""} onChange={(v: string) => setEditingItem({ ...editingItem, appName: v })} />
            <InputField label={ct("messages.slogan", "口号", "Slogan")} value={editingItem.slogan || ""} onChange={(v: string) => setEditingItem({ ...editingItem, slogan: v })} />
          </>
        );
      case "splashScreen":
        return (
          <>
            <InputField label="ID" value={editingItem.id} disabled />
            <CmsStorageUploadRow label={ct("messages.full_screen_splash_image_url", "全屏背景图 URL", "Full-screen splash image URL")} value={editingItem.imageUrl || ""} onChange={(v: string) => setEditingItem({ ...editingItem, imageUrl: v })} mode="image" />
            <InputField label={ct("messages.min_display_ms", "最短展示时间（毫秒）", "Min display (ms)")} value={String(editingItem.minDisplayMs ?? 2000)} onChange={(v: string) => setEditingItem({ ...editingItem, minDisplayMs: parseInt(v, 10) || 0 })} type="number" />
            <InputField label={ct("messages.max_resource_wait_ms", "资源最长等待（毫秒）", "Max resource wait (ms)")} value={String(editingItem.maxResourceWaitMs ?? 4000)} onChange={(v: string) => setEditingItem({ ...editingItem, maxResourceWaitMs: parseInt(v, 10) || 300 })} type="number" />
            <div className="flex items-center gap-2">
              <input type="checkbox" id="splash-skip" checked={editingItem.showSkipButton !== false} onChange={(e) => setEditingItem({ ...editingItem, showSkipButton: e.target.checked })} className="rounded border-gray-300 text-emerald-600" />
              <label htmlFor="splash-skip" className="text-sm text-gray-700">{ct("messages.show_skip_button", "显示「跳过」按钮", "Show skip button")}</label>
            </div>
            {editingItem.imageUrl ? (
              <div className="mt-2">
                <p className="text-xs text-gray-500 mb-1">{ct("headers.preview", "预览", "Preview")}</p>
                <p className="text-[10px] text-gray-400 mb-2">{ct("messages.__________________________", "Whole image scaled to fit; full-screen on device may still crop per app CSS.", "Whole image scaled to fit; on-device splash may still crop.")}</p>
                <div className="rounded-lg border border-gray-200 bg-gray-100 flex justify-center items-start max-h-[min(70vh,520px)] overflow-y-auto">
                  <img
                    src={editingItem.imageUrl}
                    alt=""
                    className="max-w-full w-auto h-auto max-h-[min(70vh,520px)] object-contain"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                </div>
              </div>
            ) : null}
          </>
        );
      case "chatContact":
        return (
          <>
            {/* 扫码绑定的商家信息（只读，由 merchant-bind-resolve 写入） */}
            <div className="mt-2 mb-2 p-3 bg-gray-50 rounded-xl border border-gray-200 space-y-1">
              <p className="text-xs font-semibold text-gray-700 mb-1">{ct("messages.bound_merchant_read_only", "已绑定商家（只读）", "Bound Merchant (read-only)")}</p>
              <p className="text-[11px] text-gray-600">{ct("messages.merchant_user_id", "商家账号ID", "Merchant User ID")}: <span className="font-mono">{editingItem.merchantUserId || '-'}</span></p>
              <p className="text-[11px] text-gray-600">Channel ID: <span className="font-mono">{editingItem.channelId || '-'}</span></p>
              <p className="text-[11px] text-gray-600">{ct("messages.name", "名称", "Name")}: {editingItem.name || '-'}</p>
              <p className="text-[11px] text-gray-600">{ct("messages.subtitle", "副标题", "Subtitle")}: {editingItem.subtitle || '-'}</p>
              <p className="text-[10px] text-gray-400 mt-1">{ct("messages.populated_by_the_merchant_bind_resolve_edge_function", "农户扫门店二维码后由 Edge Function 写入，无需手动编辑。", "Populated by the merchant-bind-resolve Edge Function after scanning a store QR; no manual editing.")}</p>
            </div>

            <div className="rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-900/90">
              {ct("messages.edit_the_domain_whitelist_in_the_section_at", "域名白名单请在本页顶部「扫码绑定 · 域名校验白名单」区域统一编辑。保存配置后随配置下发至客户端。", "Edit the domain whitelist in the section at the top of this page. It is included when you save the config to clients.")}
            </div>

            {/* 绑定状态只读展示 */}
            {editingItem.boundAt && (
              <div className="mt-2 p-3 bg-green-50 rounded-xl border border-green-200">
                <p className="text-xs font-semibold text-green-700 mb-1">{ct("messages.qr_binding_record", "扫码绑定记录", "QR Binding Record")}</p>
                <p className="text-[10px] text-green-600">{ct("messages.bound_at", "绑定时间", "Bound At")}: {new Date(editingItem.boundAt).toLocaleString()}</p>
                {editingItem.boundFrom && <p className="text-[10px] text-green-600">{ct("messages.source_domain", "来源域名", "Source Domain")}: {editingItem.boundFrom}</p>}
              </div>
            )}
          </>
        );
      case "desktopIcon":
        return (
          <>
            <InputField label={ct("messages.app_name", "应用名称", "App Name")} value={editingItem.appName || ""} onChange={(v: string) => setEditingItem({ ...editingItem, appName: v })} />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={pwaIconBusy}
                onClick={() => {
                  pwaIconTargetRef.current = "drawer";
                  pwaIconInputRef.current?.click();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-violet-200 bg-violet-50 text-violet-800 hover:bg-violet-100 disabled:opacity-50"
              >
                {pwaIconBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudUpload className="w-4 h-4" />}
                {ct("messages.upload_image_192_512", "上传图片并生成 192 + 512", "Upload image → 192 & 512")}
              </button>
              <span className="text-[11px] text-gray-500">
                {ct("messages.center_crop_square_then_resize", "自动中心裁正方形", "Center-crop square, then resize")}
              </span>
            </div>
            {pwaIconErr ? <p className="text-xs text-red-600">{pwaIconErr}</p> : null}
            <CmsStorageUploadRow label={ct("messages.icon_192px_url", "192px图标链接", "Icon 192px URL")} value={editingItem.icon192Url || ""} onChange={(v: string) => setEditingItem({ ...editingItem, icon192Url: v })} mode="image" />
            <CmsStorageUploadRow label={ct("messages.icon_512px_url", "512px图标链接", "Icon 512px URL")} value={editingItem.icon512Url || ""} onChange={(v: string) => setEditingItem({ ...editingItem, icon512Url: v })} mode="image" />
            <PwaIconInstallPreview
              icon192Url={editingItem.icon192Url}
              icon512Url={editingItem.icon512Url}
              ct={ct}
            />
          </>
        );
      case "aiModel":
        return (
          <>
            <InputField label="ID" value={editingItem.id} disabled />
            <InputField label={ct("messages.model_name", "模型名称", "Model Name")} value={editingItem.name || ""} onChange={(v: string) => setEditingItem({ ...editingItem, name: v })} />
            <TextAreaField label={ct("headers.description", "描述", "Description")} value={editingItem.description || ""} onChange={(v: string) => setEditingItem({ ...editingItem, description: v })} rows={2} placeholder={ct("messages.model_description", "模型描述", "Model description")} />
            <TextAreaField label={ct("messages.parameters", "参数", "Parameters")} value={editingItem.parameters || ""} onChange={(v: string) => setEditingItem({ ...editingItem, parameters: v })} rows={2} placeholder={ct("messages.model_parameters", "模型参数", "Model parameters")} />
          </>
        );
      default:
        return null;
    }
  };

  const getTabName = (tab: string) => {
    switch (tab) {
      case "supabase": return ct("navItems.supabase", "服务器连接", "Server connection");
      case "banners": return ct("messages.safety_guard", "安全守护", "Safety Guard");
      case "live": return ct("messages.live", "直播", "Live");
      case "articles": return ct("messages.articles", "文章", "Articles");
      case "marketCategories": return ct("messages.market_categories", "市场类别", "Market Categories");
      case "marketProducts": return ct("messages.market_products", "市场产品", "Market Products");
      case "marketAd": return ct("messages.market_ads", "市场广告", "Market Ads");
      case "market": return ct("navItems.marketMgmt", "市场管理", "Market");
      case "filing": return ct("navItems.filing", "备案信息", "Filing Info");
      case "aboutUs": return ct("navItems.aboutUs", "关于我们", "About Us");
      case "privacy": return ct("navItems.privacy", "隐私政策", "Privacy Policy");
      case "terms": return ct("navItems.terms", "服务条款", "Terms of Service");
      case "technicalSupport": return ct("navItems.technicalSupport", "技术支持", "Technical Support");
      case "appBranding": return ct("navItems.branding", "应用品牌", "App Branding");
      case "splashScreen": return ct("navItems.splash", "启动页", "Splash Screen");
      case "homeIcons": return ct("messages.home_features", "首页功能区", "Home Features");
      case "chatContact": return ct("navItems.chatContact", "聊天联系", "Chat Contact");
      case "desktopIcon": return ct("navItems.desktopIcon", "桌面图标", "Desktop Icon");
      case "aiModel": return ct("navItems.aiModel", "AI模型", "AI Model");
      case "backendProxy": return ct("navItems.imBackend", "IM后端代理", "IM Backend Proxy");
      case "pushProviders": return ct("messages.push_services", "推送服务", "Push Services");
      case "pushNotification": return ct("navItems.pushNotification", "发送通知", "Push Notification");
      case "userRoles": return ct("navItems.userRoles", "用户与角色", "Users & roles");
      default: return "";
    }
  };

  return (
    <div className="fixed inset-0 bg-gray-50 flex flex-col overflow-hidden" style={{ transform: animPhase === 'visible' ? 'none' : 'scale(0.96)', opacity: animPhase === 'visible' ? 1 : 0, transition: 'transform 200ms ease-out, opacity 200ms ease-out' }}>
      <input
        ref={pwaIconInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          const target = pwaIconTargetRef.current;
          pwaIconTargetRef.current = null;
          if (f && target) void runPwaCombinedIconUpload(f, target);
        }}
      />
      <input
        ref={roleExcelInputRef}
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void handleRoleExcelFile(f);
        }}
      />
      {/* 状态栏占位 — standalone 模式下用 safe-area-inset-top 撇开 */}
      <div className="bg-emerald-600 safe-top flex-shrink-0" />

      {/* 顶部导航栏 */}
      <div className="bg-emerald-600 text-white px-4 py-3 flex items-center justify-between flex-shrink-0 z-40 shadow-lg">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={handleGoBack} className="p-1.5 hover:bg-emerald-700 rounded-lg transition-colors flex-shrink-0">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-1.5 hover:bg-emerald-700 rounded-lg transition-colors flex-shrink-0 lg:hidden">
            <Menu className="w-4 h-4" />
          </button>
          <h1 className="font-semibold text-base sm:text-lg truncate">{ct("topBar.title", "内容管理器", "Content Manager")}</h1>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={handleSaveLocalOnly}
            disabled={!hasChanges || pushRemoteBusy}
            title={ct("messages.changes_show_here_immediately_saves_draft_to_this", "内容管理器内已实时预览；此按钮将草稿写入本机，供 App 商城页查看", "Changes show here immediately. Saves draft to this device for the Market tab in the app.")}
            className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors text-sm ${
              hasChanges && !pushRemoteBusy
                ? "bg-white text-emerald-700 hover:bg-emerald-50 shadow-sm"
                : "bg-emerald-700/50 text-emerald-200 cursor-not-allowed"
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{ct("topBar.saveToDevice", "保存到本机", "Save locally")}</span>
            <span className="sm:hidden">{ct("topBar.preview", "预览", "Preview")}</span>
          </button>
          <button
            type="button"
            onClick={() => void handlePushToSupabase()}
            disabled={
              pushRemoteBusy ||
              hasChanges ||
              !isSupabaseConfigured(
                workingConfig.backendProxyConfig?.supabaseUrl,
                workingConfig.backendProxyConfig?.supabaseAnonKey,
              )
            }
            title={
              hasChanges
                ? ct("topBar.saveLocallyFirst", "请先点击「保存到本机」", "Use \"Save locally\" first")
                : !isSupabaseConfigured(
                    workingConfig.backendProxyConfig?.supabaseUrl,
                    workingConfig.backendProxyConfig?.supabaseAnonKey,
                  )
                  ? ct("topBar.configureServer", "请配置服务器连接", "Configure server connection first")
                  : ct("topBar.publishHint", "将当前已写入本机的配置推送到云端", "Publish locally saved config to the cloud")
            }
            className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors text-sm border border-white/30 ${
              !pushRemoteBusy &&
              !hasChanges &&
              isSupabaseConfigured(
                workingConfig.backendProxyConfig?.supabaseUrl,
                workingConfig.backendProxyConfig?.supabaseAnonKey,
              )
                ? "bg-emerald-500 text-white hover:bg-emerald-400 shadow-sm"
                : "bg-emerald-800/40 text-emerald-200/80 cursor-not-allowed"
            }`}
          >
            {pushRemoteBusy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <CloudUpload className="w-3.5 h-3.5" />
            )}
            <span className="truncate max-w-[9rem] sm:max-w-none">
              {pushRemoteBusy ? ct("topBar.pushing", "推送中…", "Pushing…") : ct("topBar.pushToCloud", "推送到云端", "Push to cloud")}
            </span>
          </button>
        </div>
      </div>

      {/* 侧边栏 + 内容区 */}
      <div className="flex-1 flex overflow-hidden relative">

      {/* Mobile backdrop */}
      {sidebarOpen && <div className="absolute inset-0 bg-black/40 z-30 lg:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* 侧边栏 */}
      <aside className={`absolute lg:static top-0 bottom-0 left-0 z-40 lg:z-auto w-52 flex-shrink-0 bg-white border-r border-gray-200 overflow-y-auto transition-transform duration-200 ease-out ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <nav className="py-2">
          {/* Supabase 独立入口 — admin only（DEV 模式允许未配置角色访问） */}
          {(isDeveloperMode() || contentRole === 'admin') && (
          <div className="px-2 pt-1 pb-1">
            <button
              onClick={() => { setActiveTab('supabase'); setSidebarOpen(false); }}
              className={`w-full text-start px-3 py-2.5 rounded-lg transition-colors text-sm flex items-center justify-between ${activeTab === 'supabase' ? 'bg-emerald-50 text-emerald-700 font-medium' : 'text-gray-700 hover:bg-gray-50'}`}
            >
              <span>{ct("navItems.supabase", "服务器连接", "Server connection")}</span>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                syncStatus === 'synced' ? 'bg-emerald-500' :
                syncStatus === 'syncing' ? 'bg-blue-500 animate-pulse' :
                syncStatus === 'error' || syncStatus === 'conflict' ? 'bg-red-500' :
                isRemoteConfigured ? 'bg-amber-400' : 'bg-gray-300'
              }`} />
            </button>
            {(isDeveloperMode() || contentRole === 'admin') && (
              <button
                type="button"
                onClick={() => { setActiveTab('userRoles'); setSidebarOpen(false); }}
                className={`w-full text-start px-3 py-2.5 rounded-lg transition-colors text-sm mt-1 ${activeTab === 'userRoles' ? 'bg-emerald-50 text-emerald-700 font-medium' : 'text-gray-700 hover:bg-gray-50'}`}
              >
                {ct("navItems.userRoles", "用户与角色", "Users & roles")}
              </button>
            )}
            <div className="mx-3 mt-1 mb-1 border-b border-gray-200" />
          </div>
          )}

          {/* 分组项 */}
          {(() => {
            const editorGroups = new Set(['content', 'market', 'appearance', 'legal', 'push']);
            const allGroups = [
              { id: 'content', label: ct("sidebar.content", "内容管理", "Content"), items: [
                { key: 'banners', label: ct("navItems.banners", "轮播横幅", "Banners") },
                { key: 'live', label: ct("navItems.live", "直播列表", "Live Streams") },
                { key: 'articles', label: ct("navItems.articles", "文章列表", "Articles") },
              ]},
              { id: 'market', label: ct("sidebar.market", "市场管理", "Market"), items: [
                { key: 'market', label: ct("navItems.marketMgmt", "市场管理", "Market") },
              ]},
              { id: 'appearance', label: ct("sidebar.appearance", "外观配置", "Appearance"), items: [
                { key: 'appBranding', label: ct("navItems.branding", "应用品牌", "Branding") },
                { key: 'splashScreen', label: ct("navItems.splash", "启动页", "Splash") },
                { key: 'homeIcons', label: ct("navItems.homeIcons", "首页图标", "Home Icons") },
                { key: 'desktopIcon', label: ct("navItems.desktopIcon", "桌面图标", "Desktop Icon") },
              ]},
              { id: 'legal', label: ct("sidebar.legal", "法务信息", "Legal"), items: [
                { key: 'filing', label: ct("navItems.filing", "备案信息", "Filing") },
                { key: 'aboutUs', label: ct("navItems.aboutUs", "关于我们", "About Us") },
                { key: 'privacy', label: ct("navItems.privacy", "隐私政策", "Privacy") },
                { key: 'terms', label: ct("navItems.terms", "服务条款", "Terms") },
                { key: 'technicalSupport', label: ct("navItems.technicalSupport", "技术支持", "Technical Support") },
              ]},
              { id: 'im', label: ct("sidebar.messaging", "通讯配置", "Messaging"), items: [
                { key: 'backendProxy', label: ct("navItems.imBackend", "IM后端代理", "IM Backend") },
                { key: 'chatContact', label: ct("navItems.chatContact", "聊天联系人", "Chat Contact") },
              ]},
              { id: 'ai', label: ct("sidebar.aiConfig", "AI 配置", "AI Config"), items: [
                { key: 'aiModel', label: ct("navItems.aiModel", "AI模型", "AI Model") },
              ]},
              { id: 'auth', label: ct("sidebar.auth", "认证配置", "Auth"), items: [
                { key: 'loginConfig', label: ct("navItems.loginConfig", "登录配置", "Login") },
              ]},
              { id: 'push', label: ct("sidebar.push", "推送服务", "Push"), items: [
                { key: 'pushProviders', label: ct("navItems.pushProviders", "推送服务商", "Providers") },
                { key: 'pushNotification', label: ct("navItems.pushNotification", "发送通知", "Push Notification") },
              ]},
            ];
            const visibleGroups = allGroups.filter(group => {
              if (contentRole === 'admin') return true;
              if (contentRole === 'editor') return editorGroups.has(group.id);
              // DEV 模式：允许未配置角色的开发者访问全部设置（生产环境由 ConfigManagerGate 拦截 none 用户）
              if (isDeveloperMode()) return true;
              // 生产：本页与 Gate 各有一份 useEdgeProfile 状态；首屏可能仍在拉 /profile，此时 contentRole 暂为 none。
              // 若此处直接隐藏全部侧栏，会看不到「推送服务」等入口。Gate 已保证仅 admin/editor 可进入。
              if (contentRoleLoading) return true;
              return false;
            });
            return visibleGroups.map((group) => {
            const isCollapsed = collapsedGroups.has(group.id);
            return (
              <div key={group.id}>
                <button
                  onClick={() => setCollapsedGroups(prev => { const n = new Set(prev); if (n.has(group.id)) n.delete(group.id); else n.add(group.id); return n; })}
                  className="w-full text-start px-4 py-1.5 text-[11px] text-gray-400 hover:text-gray-600 transition-colors flex items-center justify-between"
                >
                  <span className="uppercase tracking-wider">{group.label}</span>
                  <ChevronDown className={`w-3 h-3 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                </button>
                {!isCollapsed && group.items.map((item) => (
                  <button
                    key={item.key}
                    onClick={() => { setActiveTab(item.key as any); setSidebarOpen(false); }}
                    className={`w-full text-start px-5 py-2 text-sm transition-colors ${activeTab === item.key ? 'bg-emerald-50 text-emerald-700 font-medium border-r-2 border-emerald-600' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-800'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            );
            })
          })()}
        </nav>
      </aside>

      {/* 可滚动内容区域 */}
      <div className={`flex-1 ${activeTab === "market" ? "overflow-hidden flex flex-col min-h-0" : "overflow-y-auto"} overflow-x-hidden`}>

      {/* 主内容区 - with header showing current tab name */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <h2 className="text-base text-gray-800">{getTabName(activeTab)}</h2>
        {!["homeIcons", "desktopIcon", "aiModel", "backendProxy", "loginConfig", "pushProviders", "pushNotification", "supabase", "splashScreen", "market", "userRoles"].includes(activeTab) && (
          <button
            onClick={() => handleAddItem(activeTab)}
            className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors flex items-center gap-1.5 text-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            {ct("buttons.add", "添加", "Add")}
          </button>
        )}
      </div>
      {activeTab === "market" ? (
        <div className="flex-1 min-h-0">
          {renderTable()}
        </div>
      ) : (
      <div className="p-4 max-w-7xl mx-auto">
        {activeTab === "supabase" ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50/90 px-3 py-2.5 text-[11px] text-amber-950 leading-relaxed">
              <span className="inline-flex items-start gap-1.5">
                <Shield className="w-4 h-4 flex-shrink-0 text-amber-700 mt-0.5" aria-hidden />
                <span>
                  {ct("messages.security_this_page_is_for_content_super_admins", "安全与权限：本页仅对「内容超级管理员」开放。仓库/出厂 JSON 中不应包含真实项目 URL 与密钥，请在下方填写你方 Supabase Dashboard → Settings → API 中的值。仅重置本机配置（agri_home_config）不会退出登录；若本机已填写 config 写密钥，重置模板时会尽量保留，以免无法继续推送到云端。", "Security: this page is for content super-admins only. Bundled JSON must not contain real project URLs or keys—use your Supabase Dashboard → Settings → API values below. Resetting local app config (agri_home_config) does not sign you out. If a config write secret was set locally, it is kept when applying factory defaults so publishing can continue.")}
                </span>
              </span>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-4">
              <h3 className="text-base text-gray-800 mb-2">{ct("messages.server_connection_settings", "服务器连接配置", "Server connection settings")}</h3>
              <p className="text-xs text-gray-500 -mt-2">{ct("messages.configure_your_self_hosted_supabase_project_this_connection", "配置你的自建 Supabase 项目。此连接被 IM通讯、云端AI、推送服务、登录认证等所有后端功能共用。Anon Key 是公开的，可安全放在前端。", "Configure your self-hosted Supabase project. This connection is shared by IM messaging, Cloud AI, push notifications, login auth, and all backend features. Anon Key is public and safe for frontend.")}</p>

              {/* Connection Status */}
              {(() => {
                const configured = isSupabaseConfigured(workingConfig.backendProxyConfig?.supabaseUrl, workingConfig.backendProxyConfig?.supabaseAnonKey);
                return (
                  <div className={`flex items-center gap-3 p-3 rounded-lg border ${configured ? 'bg-emerald-50 border-emerald-200' : 'bg-gray-50 border-gray-200'}`}>
                    <div className={`w-3 h-3 rounded-full flex-shrink-0 ${configured ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                    <span className="text-sm text-gray-700">
                      {configured
                        ? ct("messages.configured_ready", "已配置 — 就绪", "Configured — Ready")
                        : ct("messages.not_configured_fill_in_the_fields_below", "未配置 — 请填写以下信息", "Not configured — fill in the fields below")
                      }
                    </span>
                  </div>
                );
              })()}

              {/* Supabase URL */}
              <div>
                <label className="block text-sm text-gray-700 mb-1">Supabase URL</label>
                <input
                  type="text"
                  value={workingConfig.backendProxyConfig?.supabaseUrl || ""}
                  onChange={(e) => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    if (!newConfig.backendProxyConfig) newConfig.backendProxyConfig = emptyBackendProxyShell();
                    newConfig.backendProxyConfig.supabaseUrl = e.target.value;
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  placeholder="https://your-project-ref.supabase.co"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                />
                <p className="mt-1 text-[11px] text-gray-400">{ct("messages.supabase_dashboard_settings_api_project_url", "Supabase Dashboard → Settings → API → Project URL", "Supabase Dashboard → Settings → API → Project URL")}</p>
              </div>

              {/* Supabase Anon Key */}
              <div>
                <label className="block text-sm text-gray-700 mb-1">Supabase Anon Key</label>
                <input
                  type="text"
                  value={workingConfig.backendProxyConfig?.supabaseAnonKey || ""}
                  onChange={(e) => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    if (!newConfig.backendProxyConfig) newConfig.backendProxyConfig = emptyBackendProxyShell();
                    newConfig.backendProxyConfig.supabaseAnonKey = e.target.value;
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                />
                <p className="mt-1 text-[11px] text-gray-400">{ct("messages.anon_key_is_public_identifies_project_not_the", "Anon Key 是公开的（标识项目），不等于 Service Role Key。Dashboard → Settings → API → anon public", "Anon Key is public (identifies project), NOT the Service Role Key. Dashboard → Settings → API → anon public")}</p>
              </div>

              {/* CMS upload storage (banner/article/rich-text; not chat) */}
              <div>
                <label className="block text-sm text-gray-700 mb-1">
                  {ct("messages.cms_media_storage", "CMS 媒体上传存储", "CMS media storage")}
                </label>
                <select
                  value={workingConfig.backendProxyConfig?.cmsStorageProvider ?? "supabase"}
                  onChange={(e) => {
                    const v = e.target.value as CmsStorageProvider;
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    if (!newConfig.backendProxyConfig) newConfig.backendProxyConfig = emptyBackendProxyShell();
                    newConfig.backendProxyConfig.cmsStorageProvider = v;
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm bg-white"
                >
                  <option value="supabase">{ct("messages.supabase_storage", "Supabase Storage", "Supabase Storage")}</option>
                  <option value="cloudflare_r2">{ct("messages.cloudflare_r2", "Cloudflare R2", "Cloudflare R2")}</option>
                  <option value="aliyun_oss">{ct("messages.alibaba_cloud_oss", "阿里云 OSS", "Alibaba Cloud OSS")}</option>
                  <option value="tencent_cos">{ct("messages.tencent_cloud_cos", "腾讯云 COS", "Tencent Cloud COS")}</option>
                </select>
                <p className="mt-1 text-[11px] text-gray-400">
                  {ct("messages.affects_images_videos_uploaded_from_the_content_manager", "仅影响内容管理器内的图片/视频上传（轮播、文章、富文本等）。非 Supabase 时请在 Edge Secrets 配置 CMS_R2_* / CMS_ALIYUN_* / CMS_TENCENT_*，详见项目文档。聊天媒体仍用 Supabase Storage。", "Affects images/videos uploaded from the Content Manager (banners, articles, rich text). For non-Supabase, set Edge Secrets CMS_R2_* / CMS_ALIYUN_* / CMS_TENCENT_* — see project docs. Chat media still uses Supabase Storage.")}
                </p>
              </div>

              <div>
                <label className="block text-sm text-gray-700 mb-1">
                  {ct("messages.cms_media_cdn_base_url", "CMS 媒体 CDN 地址", "CMS media CDN base URL")}
                </label>
                <input
                  type="url"
                  value={workingConfig.backendProxyConfig?.mediaCdnBaseUrl || ""}
                  onChange={(e) => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    if (!newConfig.backendProxyConfig) newConfig.backendProxyConfig = emptyBackendProxyShell();
                    newConfig.backendProxyConfig.mediaCdnBaseUrl = e.target.value;
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  placeholder="https://cdn.example.com/media"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                />
                <p className="mt-1 text-[11px] text-gray-400">
                  {ct(
                    "messages.cms_media_cdn_base_url_hint",
                    "留空则相对路径回退 Supabase 公开 URL；填写后展示走 CDN（须先在 Cloudflare 部署 media Worker 并绑定域名，见仓库 cloudflare/README.md）。完整 http(s) 外链不受影响。",
                    "Leave empty to fall back to Supabase public URLs for relative paths; when set, display uses CDN (deploy the media Worker to your CDN domain first — see cloudflare/README.md). Full http(s) external URLs are unchanged.",
                  )}
                </p>
              </div>

              {/* Connection Test — 按钮右侧即时状态 */}
              <div className="pt-2">
                <div className="flex flex-wrap items-start gap-3">
                  <button
                    type="button"
                    disabled={supabaseTestLoading}
                    onClick={async () => {
                      const url = workingConfig.backendProxyConfig?.supabaseUrl;
                      const key = workingConfig.backendProxyConfig?.supabaseAnonKey;
                      setSupabaseTestMessage(null);
                      if (!url || !key) {
                        const msg = ct("messages.please_fill_in_url_and_anon_key_first", "请先填写 URL 和 Anon Key", "Please fill in URL and Anon Key first");
                        setSupabaseTestMessage({ kind: "err", text: msg });
                        return;
                      }
                      setSupabaseTestLoading(true);
                      try {
                        const efn = workingConfig.backendProxyConfig?.edgeFunctionName || "server";
                        const result = await supabaseTestConnection(url, key, efn);
                        if (result.ok) {
                          if (result.tableExists) {
                            const msg = ct(
                              `连接成功（${result.latencyMs}ms）。app_config 已就绪（客户端不再用远程 JSON 覆盖本地，内容以发版与本地保存为准）。`,
                              `Connected (${result.latencyMs}ms). "app_config" exists (client does not overwrite local config from remote; use releases + local saves).`,
                            );
                            setSupabaseTestMessage({ kind: "ok", text: msg });
                          } else {
                            const msg = ct(
                              `已连通 Edge（${result.latencyMs}ms），但未找到 app_config。请在 SQL Editor 执行 migrations/001_init.sql。`,
                              `Edge reachable (${result.latencyMs}ms), but "app_config" missing. Run migrations/001_init.sql in SQL Editor.`,
                            );
                            setSupabaseTestMessage({
                              kind: "warn",
                              text: result.error ? `${msg}\n${result.error}` : msg,
                            });
                          }
                        } else {
                          setSupabaseTestMessage({
                            kind: "err",
                            text: formatSupabaseTestFailure(result),
                          });
                        }
                      } catch (e) {
                        console.error("[ConfigManager] testConnection:", e);
                        setSupabaseTestMessage({
                          kind: "err",
                          text: ct("messages.test_failed_open_developer_tools_f12_and_check", "测试过程出错，请打开浏览器开发者工具（F12）查看 Console。", "Test failed. Open Developer Tools (F12) and check the Console."),
                        });
                      } finally {
                        setSupabaseTestLoading(false);
                      }
                    }}
                    className="flex-shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm disabled:opacity-60 disabled:pointer-events-none min-h-[40px]"
                  >
                    {ct("messages.test_connection", "测试连接", "Test Connection")}
                  </button>

                  <div
                    ref={supabaseTestMessageRef}
                    className="flex-1 min-w-[min(100%,220px)] max-w-xl rounded-lg border border-gray-200 bg-gray-50/90 px-3 py-2 min-h-[40px] flex flex-col justify-center"
                  >
                    {supabaseTestLoading ? (
                      <div className="flex items-center gap-2 text-sm text-blue-700">
                        <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" aria-hidden />
                        <span>{ct("messages.checking_edge_and_app_config", "正在检测 Edge 与 app_config…", "Checking Edge and app_config…")}</span>
                      </div>
                    ) : supabaseTestMessage ? (
                      <>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                              supabaseTestMessage.kind === "ok"
                                ? "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200"
                                : supabaseTestMessage.kind === "warn"
                                  ? "bg-amber-100 text-amber-900 ring-1 ring-amber-200"
                                  : "bg-red-100 text-red-800 ring-1 ring-red-200"
                            }`}
                          >
                            {supabaseTestMessage.kind === "ok"
                              ? ct("messages.ok", "连接正常", "OK")
                              : supabaseTestMessage.kind === "warn"
                                ? ct("messages.ok_db_setup_needed", "已连通 · 需建表", "OK · DB setup needed")
                                : ct("messages.failed", "连接失败", "Failed")}
                          </span>
                          <span className="text-[11px] text-gray-500">
                            {supabaseTestMessage.kind === "ok"
                              ? ct("messages.edge_table_ok", "Edge / 表就绪", "Edge / table OK")
                              : supabaseTestMessage.kind === "warn"
                                ? ct("messages.run_001_init_sql", "请执行 001_init.sql", "Run 001_init.sql")
                                : ct("messages.see_details_below", "请根据下方说明排查", "See details below")}
                          </span>
                        </div>
                        <p
                          className={`mt-1.5 text-xs leading-relaxed whitespace-pre-wrap break-words ${
                            supabaseTestMessage.kind === "ok"
                              ? "text-emerald-800"
                              : supabaseTestMessage.kind === "warn"
                                ? "text-amber-900"
                                : "text-red-700"
                          }`}
                        >
                          {supabaseTestMessage.text}
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-gray-400">
                        {ct("messages.click_test_connection_status_appears_here", "点击左侧按钮后，此处显示连接是否正常。", "Click \"Test Connection\" — status appears here.")}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Which modules use this connection */}
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
              <h4 className="text-sm text-gray-700">{ct("messages.modules_using_this_connection", "依赖此连接的功能模块", "Modules using this connection")}</h4>
              {([
                { label: ct("messages.im_backend_proxy", "IM 后端代理", "IM Backend Proxy"), tab: "backendProxy", desc: ct("messages.chat_messaging_token_generation", "聊天消息收发、Token生成", "Chat messaging, token generation"), field: "backendProxyConfig.enabled" },
                { label: ct("messages.cloud_ai_analysis", "云端 AI 分析", "Cloud AI Analysis"), tab: "aiModel", desc: ct("messages.pest_analysis_qwen_gemini_gpt_4o", "病虫害深度分析（通义千问/Gemini/GPT-4o）", "Pest analysis (Qwen/Gemini/GPT-4o)"), field: "cloudAIConfig.enabled" },
                { label: ct("messages.push_notifications", "推送服务", "Push Notifications"), tab: "pushProviders", desc: ct("messages.push_proxy_vapid_fcm_jpush_getui", "消息推送代理（VAPID/FCM/极光/个推）", "Push proxy (VAPID/FCM/JPush/GeTui)"), field: "pushProvidersConfig" },
                { label: ct("messages.login_auth", "登录认证", "Login Auth"), tab: "loginConfig", desc: ct("messages.which_login_buttons_to_show", "登录页显示哪些入口", "Which login buttons to show"), field: "loginConfig" },
              ] as const).map((mod) => {
                const isEnabled = mod.field === 'backendProxyConfig.enabled' ? workingConfig.backendProxyConfig?.enabled
                  : mod.field === 'cloudAIConfig.enabled' ? workingConfig.cloudAIConfig?.enabled
                  : true;
                return (
                  <button
                    key={mod.tab}
                    onClick={() => setActiveTab(mod.tab as any)}
                    className="w-full text-start flex items-center gap-3 p-3 rounded-lg border border-gray-100 hover:bg-gray-50 transition-colors"
                  >
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isEnabled ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-gray-800">{mod.label}</span>
                      <p className="text-[11px] text-gray-400 truncate">{mod.desc}</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  </button>
                );
              })}
            </div>

            {/* Security */}
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-xs text-amber-800 mb-2">{ct("messages.security_notes", "安全须知", "Security Notes")}</p>
              <ul className="text-[11px] text-amber-700 space-y-1 list-disc list-inside">
                <li>{ct("messages.only_anon_key_public_is_stored_here_all", "此处只存放 Anon Key（公开），所有 API 密钥/Secret 必须存放在服务端环境变量中（如 Supabase Secrets、Cloudflare 环境变量等）", "Only Anon Key (public) is stored here. All API keys/secrets must be in server-side env vars (Supabase Secrets, Cloudflare env, etc.)")}</li>
                <li>{ct("messages.service_role_key_must_never_be_in_frontend", "Service Role Key 绝对不能放在前端代码中", "Service Role Key must NEVER be in frontend code")}</li>
              </ul>
            </div>

            {/* Remote Config Sync Status */}
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
              <h4 className="text-sm text-gray-800 flex items-center gap-2">
                <Cloud className="w-4 h-4" />
                {ct("messages.remote_config_sync", "远程配置同步", "Remote Config Sync")}
              </h4>
              <p className="text-[11px] text-gray-500">{ct("messages.the_top_preview_button_saves_locally_for_in", "顶部「预览」仅写本机以便在应用内查看；「推送到云端」才把配置同步到服务器。农户/门店端在打开或回到前台时会自动合并远程配置。下方状态为最近一次拉取远程的结果与版本号。", "The top “Preview” button saves locally for in-app review only; “Push to cloud” syncs config to the server. Farmer/store apps merge remote config on open or when returning to foreground. Status below shows the last remote fetch and version.")}</p>

              {/* Sync Status Indicator */}
              <div className={`flex items-center gap-3 p-3 rounded-lg border ${
                syncStatus === 'synced' ? 'bg-emerald-50 border-emerald-200' :
                syncStatus === 'syncing' ? 'bg-blue-50 border-blue-200' :
                syncStatus === 'error' || syncStatus === 'conflict' ? 'bg-red-50 border-red-200' :
                syncStatus === 'offline' ? 'bg-amber-50 border-amber-200' :
                'bg-gray-50 border-gray-200'
              }`}>
                {syncStatus === 'synced' && <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />}
                {syncStatus === 'syncing' && <Loader2 className="w-4 h-4 text-blue-600 flex-shrink-0 animate-spin" />}
                {syncStatus === 'error' && <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />}
                {syncStatus === 'conflict' && <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />}
                {syncStatus === 'offline' && <CloudOff className="w-4 h-4 text-amber-600 flex-shrink-0" />}
                {syncStatus === 'idle' && <Cloud className="w-4 h-4 text-gray-400 flex-shrink-0" />}

                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800">
                    {syncStatus === 'synced' && ct("messages.remote_version_ok", "远程版本已探测", "Remote version OK")}
                    {syncStatus === 'syncing' && ct("messages.probing_remote", "探测远程中...", "Probing remote...")}
                    {syncStatus === 'error' && ct("messages.sync_failed", "同步失败", "Sync Failed")}
                    {syncStatus === 'conflict' && ct("messages.version_conflict", "版本冲突", "Version Conflict")}
                    {syncStatus === 'offline' && ct("messages.offline", "离线模式", "Offline")}
                    {syncStatus === 'idle' && ct("messages.remote_not_connected", "未连接远程", "Remote Not Connected")}
                  </p>
                  {lastSyncError && (syncStatus === 'error' || syncStatus === 'conflict') && (
                    <p className="text-[11px] text-red-600 truncate mt-0.5">{lastSyncError}</p>
                  )}
                  {lastSyncTime && (
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      {ct("messages.last_probe", "上次探测", "Last probe")}: {new Date(lastSyncTime).toLocaleTimeString()}
                    </p>
                  )}
                </div>

                <div className="flex-shrink-0 text-right">
                  {remoteVersion !== null && (
                    <span className="text-[11px] text-gray-400">v{remoteVersion}</span>
                  )}
                </div>
              </div>

            </div>
          </div>
        ) : activeTab === "homeIcons" ? (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-2">
              <h3 className="text-base text-gray-800">{ct("messages.home_feature_section_config", "首页功能区配置", "Home Feature Section Config")}</h3>
              <p className="text-xs text-gray-500">{ct("messages.customize_the_icon_and_text_for_the_three", "自定义首页三个功能区块的图标、文字。所有字段留空则使用多语言默认值或默认图标。", "Customize the icon and text for the three feature sections on the homepage. Leave fields empty to use multilingual defaults or default icons.")}</p>
            </div>

            {/* ── 1. AI 助手 ── */}
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
              <div className="flex items-center gap-2 pb-2 border-b border-gray-100">
                <span className="w-6 h-6 rounded-md bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs">1</span>
                <h4 className="text-sm text-gray-800">{ct("messages.ai_assistant_button", "AI 助手按钮", "AI Assistant Button")}</h4>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">{ct("messages.button_label", "按钮文字", "Button Label")}</label>
                <input
                  type="text"
                  value={workingConfig.homeIcons?.aiAssistantLabel || ""}
                  onChange={(e) => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    if (!newConfig.homeIcons) newConfig.homeIcons = {};
                    newConfig.homeIcons.aiAssistantLabel = e.target.value;
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  placeholder={ct("messages.leave_empty_for_default_ai_assistant", "留空使用默认：AI 助手", "Leave empty for default: AI Assistant")}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm"
                />
              </div>
              <CmsStorageUploadRow
                label={ct("messages.icon_url", "图标URL", "Icon URL")}
                value={workingConfig.homeIcons?.aiAssistantIconUrl || ""}
                onChange={(v: string) => {
                  const newConfig = JSON.parse(JSON.stringify(workingConfig));
                  if (!newConfig.homeIcons) newConfig.homeIcons = {};
                  newConfig.homeIcons.aiAssistantIconUrl = v;
                  setWorkingConfig(newConfig);
                  setHasChanges(true);
                }}
                mode="image"
              />
              <p className="text-[11px] text-gray-400 mt-1">{ct("messages.recommend_square_png_svg_64_64px", "建议正方形 PNG/SVG，≥64×64px", "Recommend square PNG/SVG, ≥64×64px")}</p>
              {workingConfig.homeIcons?.aiAssistantIconUrl && (
                <div className="flex items-center gap-3 pt-1">
                  <CmsMediaImg src={workingConfig.homeIcons.aiAssistantIconUrl} alt="preview" className="w-10 h-10 rounded-lg border border-gray-200 object-contain p-0.5" />
                  <span className="text-xs text-gray-500">{workingConfig.homeIcons?.aiAssistantLabel || ct("messages.ai_assistant", "AI 助手", "AI Assistant")}</span>
                </div>
              )}
            </div>

            {/* ── 2. 对账单 ── */}
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
              <div className="flex items-center gap-2 pb-2 border-b border-gray-100">
                <span className="w-6 h-6 rounded-md bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs">2</span>
                <h4 className="text-sm text-gray-800">{ct("messages.statement_button", "对账单按钮", "Statement Button")}</h4>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">{ct("messages.button_label", "按钮文字", "Button Label")}</label>
                <input
                  type="text"
                  value={workingConfig.homeIcons?.statementLabel || ""}
                  onChange={(e) => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    if (!newConfig.homeIcons) newConfig.homeIcons = {};
                    newConfig.homeIcons.statementLabel = e.target.value;
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  placeholder={ct("messages.leave_empty_for_default_statement", "留空使用默认：对账单", "Leave empty for default: Statement")}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm"
                />
              </div>
              <CmsStorageUploadRow
                label={ct("messages.icon_url", "图标URL", "Icon URL")}
                value={workingConfig.homeIcons?.statementIconUrl || ""}
                onChange={(v: string) => {
                  const newConfig = JSON.parse(JSON.stringify(workingConfig));
                  if (!newConfig.homeIcons) newConfig.homeIcons = {};
                  newConfig.homeIcons.statementIconUrl = v;
                  setWorkingConfig(newConfig);
                  setHasChanges(true);
                }}
                mode="image"
              />
              <p className="text-[11px] text-gray-400 mt-1">{ct("messages.recommend_square_png_svg_64_64px", "建议正方形 PNG/SVG，≥64×64px", "Recommend square PNG/SVG, ≥64×64px")}</p>
              {workingConfig.homeIcons?.statementIconUrl && (
                <div className="flex items-center gap-3 pt-1">
                  <CmsMediaImg src={workingConfig.homeIcons.statementIconUrl} alt="preview" className="w-10 h-10 rounded-lg border border-gray-200 object-contain p-0.5" />
                  <span className="text-xs text-gray-500">{workingConfig.homeIcons?.statementLabel || ct("messages.statement", "对账单", "Statement")}</span>
                </div>
              )}
            </div>

            {/* ── 3. 直播 / 视频区 ── */}
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
              <div className="flex items-center gap-2 pb-2 border-b border-gray-100">
                <span className="w-6 h-6 rounded-md bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs">3</span>
                <h4 className="text-sm text-gray-800">{ct("messages.live_video_section", "直播 / 视频区", "Live / Video Section")}</h4>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">{ct("messages.cover_title", "封面标题文字", "Cover Title")}</label>
                <input
                  type="text"
                  value={workingConfig.homeIcons?.liveTitle || ""}
                  onChange={(e) => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    if (!newConfig.homeIcons) newConfig.homeIcons = {};
                    newConfig.homeIcons.liveTitle = e.target.value;
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  placeholder={ct("messages.leave_empty_for_first_live_stream_title", "留空使用第一条直播标题，如：水稻种植技术讲解", "Leave empty for first live stream title")}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm"
                />
                <p className="text-[11px] text-gray-400 mt-1">{ct("messages.white_title_shown_at_the_bottom_of_cover", "显示在封面图底部的白色标题", "White title shown at the bottom of cover image")}</p>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">{ct("messages.badge_text", "角标文字", "Badge Text")}</label>
                <input
                  type="text"
                  value={workingConfig.homeIcons?.liveBadge || ""}
                  onChange={(e) => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    if (!newConfig.homeIcons) newConfig.homeIcons = {};
                    newConfig.homeIcons.liveBadge = e.target.value;
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  placeholder={ct("messages.leave_empty_for_default_live_navigation", "留空使用默认：直播&导航", "Leave empty for default: Live & Navigation")}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm"
                />
                <p className="text-[11px] text-gray-400 mt-1">{ct("messages.text_inside_the_red_pulsing_badge_at_top", "左上角红色脉冲徽章里的文字", "Text inside the red pulsing badge at top-left")}</p>
              </div>
              <CmsStorageUploadRow
                label={ct("messages.cover_image_url", "封面图URL", "Cover Image URL")}
                value={workingConfig.homeIcons?.liveCoverUrl || ""}
                onChange={(v: string) => {
                  const newConfig = JSON.parse(JSON.stringify(workingConfig));
                  if (!newConfig.homeIcons) newConfig.homeIcons = {};
                  newConfig.homeIcons.liveCoverUrl = v;
                  setWorkingConfig(newConfig);
                  setHasChanges(true);
                }}
                mode="image"
              />
              <p className="text-[11px] text-gray-400 mt-1">{ct("messages.recommend_2_1_landscape_800_400px", "建议 2:1 横图，≥800×400px", "Recommend 2:1 landscape, ≥800×400px")}</p>
              {/* Live Section Preview — mirrors HomePage fallback chain */}
              {(() => {
                const previewCover =
                  workingConfig.homeIcons?.liveCoverUrl ||
                  workingConfig.liveStreams?.[0]?.thumbnail ||
                  "";
                const previewTitle =
                  workingConfig.homeIcons?.liveTitle ||
                  workingConfig.liveStreams?.[0]?.title ||
                  "";
                const previewBadge = workingConfig.homeIcons?.liveBadge || "";
                if (!previewCover && !previewTitle && !previewBadge) return null;
                return (
                <div className="pt-2 border-t border-gray-100">
                  <p className="text-xs text-gray-500 mb-2">{ct("headers.preview", "预览", "Preview")}</p>
                  <div className="relative w-full aspect-[2/1] rounded-xl overflow-hidden border border-gray-200">
                    {previewCover ? (
                      <CmsMediaImg src={previewCover} alt="preview" className="w-full h-full object-fill" />
                    ) : (
                      <div className="w-full h-full bg-gray-200 flex items-center justify-center text-xs text-gray-400">{ct("messages.default_thumbnail", "默认缩略图", "Default thumbnail")}</div>
                    )}
                    <div className="absolute top-1.5 left-1.5 bg-red-500 text-white px-1.5 py-0.5 rounded-full text-[10px] flex items-center gap-1">
                      <span className="w-1 h-1 bg-white rounded-full"></span>
                      {previewBadge || ct("messages.live_navigation", "直播&导航", "Live & Navigation")}
                    </div>
                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-1.5">
                      <span className="text-white text-xs">{previewTitle || ct("messages.rice_planting_techniques", "水稻种植技术讲解", "Rice Planting Techniques")}</span>
                    </div>
                  </div>
                </div>
                );
              })()}
            </div>
          </div>
        ) : activeTab === "desktopIcon" ? (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-4">
              {/* App Name */}
              <div>
                <label className="block text-sm text-gray-700 mb-1">{ct("messages.pwa_app_name", "PWA应用名称", "PWA App Name")}</label>
                <input
                  type="text"
                  value={workingConfig.desktopIcon.appName || ""}
                  onChange={(e) => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    newConfig.desktopIcon.appName = e.target.value;
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  placeholder="TaprootAgro"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={pwaIconBusy}
                  onClick={() => {
                    pwaIconTargetRef.current = "main";
                    pwaIconInputRef.current?.click();
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-violet-200 bg-violet-50 text-violet-800 hover:bg-violet-100 disabled:opacity-50"
                >
                  {pwaIconBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudUpload className="w-4 h-4" />}
                  {ct("messages.upload_image_192_512", "上传图片并生成 192 + 512", "Upload image → 192 & 512")}
                </button>
                <span className="text-[11px] text-gray-500">
                  {ct("messages.center_crop_square_then_resize", "自动中心裁正方形", "Center-crop square, then resize")}
                </span>
              </div>
              {pwaIconErr ? <p className="text-xs text-red-600">{pwaIconErr}</p> : null}

              <CmsStorageUploadRow
                label={ct("messages.m_192_192_icon_url", "192×192 图标链接", "192×192 Icon URL")}
                value={workingConfig.desktopIcon.icon192Url || ""}
                onChange={(v: string) => {
                  const newConfig = JSON.parse(JSON.stringify(workingConfig));
                  newConfig.desktopIcon.icon192Url = v;
                  setWorkingConfig(newConfig);
                  setHasChanges(true);
                }}
                mode="image"
              />

              <CmsStorageUploadRow
                label={ct("messages.m_512_512_icon_url", "512×512 图标链接", "512×512 Icon URL")}
                value={workingConfig.desktopIcon.icon512Url || ""}
                onChange={(v: string) => {
                  const newConfig = JSON.parse(JSON.stringify(workingConfig));
                  newConfig.desktopIcon.icon512Url = v;
                  setWorkingConfig(newConfig);
                  setHasChanges(true);
                }}
                mode="image"
              />

              <PwaIconInstallPreview
                icon192Url={workingConfig.desktopIcon.icon192Url}
                icon512Url={workingConfig.desktopIcon.icon512Url}
                ct={ct}
              />
            </div>
          </div>
        ) : activeTab === "aiModel" ? (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-4">
              <h3 className="text-base text-gray-800 mb-2">{ct("messages.ai_pest_disease_detection_model_config", "AI 病虫害识别模型配置", "AI Pest & Disease Detection Model Config")}</h3>
              <p className="text-xs text-gray-500 -mt-2">{ct("messages.online_deep_analysis_uses_third_party_cloud_llms", "在线深度分析依赖第三方云端大模型（经 Supabase Edge 代理）。本地 ONNX 与在线 AI 可分别开关；默认仅开启在线。关闭在线后不会请求云端；关闭本地后断网不再回退端侧推理。", "Online deep analysis uses third-party cloud LLMs (via Supabase Edge). Local ONNX and online AI can be toggled independently; default is online only. When online AI is off, no cloud requests are made. When local is off, the app does not fall back to on-device inference offline.")}</p>

              {/* Mode indicator */}
              <div className="flex items-center gap-2 bg-gray-50 rounded-lg p-3">
                <div className={`w-2 h-2 rounded-full ${
                  (() => {
                    const cOn = workingConfig.cloudAIConfig?.enabled === true;
                    const lOn = workingConfig.aiModelConfig?.enableLocalModel === true;
                    if (!cOn && !lOn) return "bg-red-400";
                    if (cOn && lOn) return "bg-emerald-500";
                    return cOn ? "bg-violet-500" : "bg-amber-500";
                  })()
                }`} />
                <span className="text-xs text-gray-600">
                  {(() => {
                    const cOn = workingConfig.cloudAIConfig?.enabled === true;
                    const lOn = workingConfig.aiModelConfig?.enableLocalModel === true;
                    const hasUrl = !!(workingConfig.aiModelConfig?.modelUrl && workingConfig.aiModelConfig.modelUrl.startsWith("http"));
                    if (!cOn && !lOn) {
                      return ct("messages.current_both_local_and_online_ai_are_off", "当前：本地与在线 AI 均已关闭，农户端将无法使用 AI 能力", "Current: Both local and online AI are off — the farmer app cannot use AI.");
                    }
                    if (cOn && lOn) {
                      return hasUrl
                        ? ct("messages.current_cloud_when_online_offline_can_use_local", "当前：联网走第三方云端；断网可走本地 ONNX（已配置模型 URL）", "Current: Cloud when online; offline can use local ONNX (model URL set).")
                        : ct("messages.current_cloud_when_online_local_is_on_but", "当前：联网走云端；本地已开但未配置有效模型 URL 时断网能力受限", "Current: Cloud when online; local is on but without a valid model URL, offline use is limited.");
                    }
                    if (cOn && !lOn) {
                      return ct("messages.current_third_party_online_ai_only_no_deep", "当前：仅第三方在线 AI（断网无深度分析、不回退本地）", "Current: Third-party online AI only (no deep analysis offline, no local fallback).");
                    }
                    return ct("messages.current_local_onnx_only_configure_model_url_no", "当前：仅本地 ONNX（需配置模型 URL；不调用云端）", "Current: Local ONNX only (configure model URL; no cloud calls).");
                  })()}
                </span>
              </div>

              {/* Local ONNX enable */}
              <div className="flex items-center justify-between py-2 border-b border-gray-100">
                <div>
                  <label className="block text-sm text-gray-700">{ct("messages.enable_local_onnx_inference", "启用本地 ONNX 推理", "Enable local ONNX inference")}</label>
                  <p className="text-[11px] text-gray-400">{ct("messages.when_off_the_app_does_not_load_or", "关闭后不再加载/运行端侧模型，断网也不回退本地。", "When off, the app does not load or run on-device models, even offline.")}</p>
                </div>
                <button
                  onClick={() => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    const prev = newConfig.aiModelConfig || {};
                    newConfig.aiModelConfig = {
                      modelUrl: prev.modelUrl ?? "",
                      labelsUrl: prev.labelsUrl ?? "",
                      enableLocalModel: !(prev.enableLocalModel ?? false),
                    };
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  className={`relative w-12 h-6 rounded-full transition-colors ${
                    workingConfig.aiModelConfig?.enableLocalModel ? "bg-emerald-500" : "bg-gray-300"
                  }`}
                >
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    workingConfig.aiModelConfig?.enableLocalModel ? "translate-x-6" : "translate-x-0.5"
                  }`} />
                </button>
              </div>

              {/* Model URL */}
              <div>
                <label className="block text-sm text-gray-700 mb-1">{ct("messages.onnx_model_file_url", "ONNX 模型文件 URL", "ONNX Model File URL")}</label>
                <input
                  type="text"
                  value={workingConfig.aiModelConfig?.modelUrl || ""}
                  onChange={(e) => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    const prev = newConfig.aiModelConfig || {};
                    newConfig.aiModelConfig = {
                      modelUrl: e.target.value,
                      labelsUrl: prev.labelsUrl ?? "",
                      enableLocalModel: prev.enableLocalModel ?? false,
                    };
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  placeholder="https://cdn.example.com/models/taprootagro.onnx"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                />
                <p className="mt-1 text-[11px] text-gray-400">{ct("messages.supports_any_publicly_accessible_url_oss_cdn_github", "支持任何可公开访问的URL（如 OSS、CDN、GitHub Release 等），文件格式需为 ONNX", "Supports any publicly accessible URL (OSS, CDN, GitHub Release, etc.), file must be in ONNX format")}</p>
              </div>

              {/* Labels URL */}
              <div>
                <label className="block text-sm text-gray-700 mb-1">{ct("messages.labels_file_url", "标签文件 URL", "Labels File URL")}</label>
                <input
                  type="text"
                  value={workingConfig.aiModelConfig?.labelsUrl || ""}
                  onChange={(e) => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    const prev = newConfig.aiModelConfig || {};
                    newConfig.aiModelConfig = {
                      modelUrl: prev.modelUrl ?? "",
                      labelsUrl: e.target.value,
                      enableLocalModel: prev.enableLocalModel ?? false,
                    };
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  placeholder="https://cdn.example.com/models/labels.json"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                />
                <p className="mt-1 text-[11px] text-gray-400">{ct("messages.json_array_format_e_g_rice_blast_powdery", "JSON 数组格式，例如：[\"稻瘟病\",\"白粉病\",\"蚜虫\",...]", "JSON array format, e.g.: [\"Rice Blast\",\"Powdery Mildew\",\"Aphids\",...]")}</p>
              </div>

              {/* Status indicator */}
              <div className="pt-3 border-t border-gray-100">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${
                    (workingConfig.aiModelConfig?.modelUrl && workingConfig.aiModelConfig.modelUrl.startsWith("http"))
                      ? "bg-emerald-500"
                      : "bg-gray-300"
                  }`} />
                  <span className="text-xs text-gray-600">
                    {(workingConfig.aiModelConfig?.modelUrl && workingConfig.aiModelConfig.modelUrl.startsWith("http"))
                      ? ct("messages.remote_model_configured", "已配置远程模型", "Remote model configured")
                      : ct("messages.not_configured_will_use_local_files_or_demo", "未配置（将使用本地文件或演示模式）", "Not configured (will use local files or demo mode)")
                    }
                  </span>
                </div>
              </div>

              {/* Help section */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mt-3">
                <p className="text-xs text-blue-800 mb-2">{ct("messages.usage_guide", "使用指南：", "Usage Guide:")}</p>
                <ol className="text-[11px] text-blue-700 space-y-1 list-decimal list-inside">
                  <li>{ct("messages.train_your_pest_disease_detection_model_with_your", "用你的病虫害数据集训练检测模型", "Train your pest & disease detection model with your dataset")}</li>
                  <li>{ct("messages.export_to_onnx_python_export_model_py_format", "导出为 ONNX：python export_model.py --format onnx --imgsz 640", "Export to ONNX: python export_model.py --format onnx --imgsz 640")}</li>
                  <li>{ct("messages.upload_onnx_and_labels_json_to_your_cdn", "将 .onnx 和 labels.json 上传到你的 CDN 或对象存储", "Upload .onnx and labels.json to your CDN or object storage")}</li>
                  <li>{ct("messages.paste_the_urls_into_the_fields_above_save", "将 URL 填入上方输入框，保存配置即可生效", "Paste the URLs into the fields above, save config to apply")}</li>
                </ol>
              </div>

            </div>

            {/* Cloud AI Deep Analysis Config Section */}
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-4">
              <h3 className="text-base text-gray-800 mb-2">{ct("messages.cloud_ai_analysis_config_backend_proxy", "云端AI分析配置（后端代理模式）", "Cloud AI Analysis Config (Backend Proxy)")}</h3>
              <p className="text-xs text-gray-500 -mt-2">{ct("messages.configure_third_party_cloud_vision_models_qwen_gemini", "配置第三方云端大模型（如通义千问、Gemini、GPT-4o）。开启且联网时才会请求 Edge 代理；关闭后前端不发起云端请求（也不会使用演示 Mock）。密钥仅存放在 Edge 环境变量中。", "Configure third-party cloud vision models (Qwen, Gemini, GPT-4o, etc.). Requests go to the Edge proxy only when this is on and the device is online. When off, the app does not call the cloud (no demo mock). Secrets live only in Edge env vars.")}</p>

              {/* Enabled Toggle */}
              <div className="flex items-center justify-between py-2">
                <div>
                  <label className="block text-sm text-gray-700">{ct("messages.enable_online_cloud_ai", "启用在线（云端）AI", "Enable online (cloud) AI")}</label>
                  <p className="text-[11px] text-gray-400">{ct("messages.on_cloud_deep_analysis_when_online_off_no", "开启：联网时可调用第三方云端深度分析；关闭：不请求云端", "On: cloud deep analysis when online. Off: no cloud requests.")}</p>
                </div>
                <button
                  onClick={() => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    const p = newConfig.cloudAIConfig || {};
                    newConfig.cloudAIConfig = {
                      enabled: !(p.enabled ?? false),
                      providerName: p.providerName ?? "通义千问",
                      edgeFunctionName: p.edgeFunctionName ?? "ai-vision-proxy",
                      modelId: p.modelId ?? "qwen-vl-plus",
                      systemPrompt: p.systemPrompt ?? "",
                      maxTokens: p.maxTokens ?? 512,
                      clientDailyLimit: p.clientDailyLimit,
                      clientCooldownSeconds: p.clientCooldownSeconds,
                      clientMaxImageSize: p.clientMaxImageSize,
                      clientImageQuality: p.clientImageQuality,
                      clientWindowPerMin: p.clientWindowPerMin,
                      clientChatMinIntervalSeconds: p.clientChatMinIntervalSeconds,
                      supabaseUrl: p.supabaseUrl ?? "",
                      supabaseAnonKey: p.supabaseAnonKey ?? "",
                      allowUnauthenticatedUse: p.allowUnauthenticatedUse ?? false,
                    };
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  className={`relative w-12 h-6 rounded-full transition-colors ${
                    workingConfig.cloudAIConfig?.enabled ? "bg-emerald-500" : "bg-gray-300"
                  }`}
                >
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    workingConfig.cloudAIConfig?.enabled ? "translate-x-6" : "translate-x-0.5"
                  }`} />
                </button>
              </div>

              {/* Allow unauthenticated AI */}
              <div className="flex items-center justify-between py-2 border-t border-gray-100">
                <div>
                  <label className="block text-sm text-gray-700">{ct("messages.allow_unauthenticated_ai", "允许不登录使用 AI", "Allow AI without login")}</label>
                  <p className="text-[11px] text-amber-600">{ct("messages.allow_unauthenticated_ai_warning", "开启后，未登录用户也可进入 AI 助手并使用云端/本地模型。会公开暴露云端 AI，建议配合 Cloudflare IP 限流。", "When on, guests can open AI Assistant and use cloud/local models. Exposes cloud AI publicly — use Cloudflare IP rate limiting.")}</p>
                </div>
                <button
                  onClick={() => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    const p = newConfig.cloudAIConfig || {};
                    newConfig.cloudAIConfig = {
                      enabled: p.enabled ?? false,
                      providerName: p.providerName ?? "通义千问",
                      edgeFunctionName: p.edgeFunctionName ?? "ai-vision-proxy",
                      modelId: p.modelId ?? "qwen-vl-plus",
                      systemPrompt: p.systemPrompt ?? "",
                      maxTokens: p.maxTokens ?? 512,
                      clientDailyLimit: p.clientDailyLimit,
                      clientCooldownSeconds: p.clientCooldownSeconds,
                      clientMaxImageSize: p.clientMaxImageSize,
                      clientImageQuality: p.clientImageQuality,
                      clientWindowPerMin: p.clientWindowPerMin,
                      clientChatMinIntervalSeconds: p.clientChatMinIntervalSeconds,
                      supabaseUrl: p.supabaseUrl ?? "",
                      supabaseAnonKey: p.supabaseAnonKey ?? "",
                      allowUnauthenticatedUse: !(p.allowUnauthenticatedUse ?? false),
                    };
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  className={`relative w-12 h-6 rounded-full transition-colors ${
                    workingConfig.cloudAIConfig?.allowUnauthenticatedUse ? "bg-emerald-500" : "bg-gray-300"
                  }`}
                >
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    workingConfig.cloudAIConfig?.allowUnauthenticatedUse ? "translate-x-6" : "translate-x-0.5"
                  }`} />
                </button>
              </div>

              {/* Supabase for cloud AI only — independent of IM toggle */}
              <div className="space-y-3 pt-1 border-t border-gray-100">
                <p className="text-xs text-gray-600">{ct("messages.supabase_for_cloud_vision_only_independent_of_im", "云端识图专用 Supabase（与「启用 IM 直连」无关）。若填写则优先使用；若留空则回退使用 IM 后端代理页中的项目地址（无需开启 IM）。", "Supabase for cloud vision only (independent of IM). If set, used first; if empty, falls back to the Backend Proxy tab URL/key (IM toggle not required).")}</p>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">{ct("messages.supabase_project_url_cloud_ai", "Supabase 项目 URL（云端识图）", "Supabase project URL (cloud AI)")}</label>
                  <input
                    type="text"
                    value={workingConfig.cloudAIConfig?.supabaseUrl || ""}
                    onChange={(e) => {
                      const newConfig = JSON.parse(JSON.stringify(workingConfig));
                      const p = newConfig.cloudAIConfig || {};
                      newConfig.cloudAIConfig = {
                        enabled: p.enabled ?? false,
                        providerName: p.providerName ?? "",
                        edgeFunctionName: p.edgeFunctionName ?? "ai-vision-proxy",
                        modelId: p.modelId ?? "",
                        systemPrompt: p.systemPrompt ?? "",
                        maxTokens: p.maxTokens ?? 512,
                        clientDailyLimit: p.clientDailyLimit,
                        clientCooldownSeconds: p.clientCooldownSeconds,
                        clientMaxImageSize: p.clientMaxImageSize,
                        clientImageQuality: p.clientImageQuality,
                        clientWindowPerMin: p.clientWindowPerMin,
                        clientChatMinIntervalSeconds: p.clientChatMinIntervalSeconds,
                        supabaseUrl: e.target.value,
                        supabaseAnonKey: p.supabaseAnonKey ?? "",
                        allowUnauthenticatedUse: p.allowUnauthenticatedUse ?? false,
                      };
                      setWorkingConfig(newConfig);
                      setHasChanges(true);
                    }}
                    placeholder="https://xxxx.supabase.co"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">{ct("messages.supabase_anon_key_cloud_ai", "Supabase Anon Key（云端识图）", "Supabase anon key (cloud AI)")}</label>
                  <input
                    type="password"
                    autoComplete="off"
                    value={workingConfig.cloudAIConfig?.supabaseAnonKey || ""}
                    onChange={(e) => {
                      const newConfig = JSON.parse(JSON.stringify(workingConfig));
                      const p = newConfig.cloudAIConfig || {};
                      newConfig.cloudAIConfig = {
                        enabled: p.enabled ?? false,
                        providerName: p.providerName ?? "",
                        edgeFunctionName: p.edgeFunctionName ?? "ai-vision-proxy",
                        modelId: p.modelId ?? "",
                        systemPrompt: p.systemPrompt ?? "",
                        maxTokens: p.maxTokens ?? 512,
                        clientDailyLimit: p.clientDailyLimit,
                        clientCooldownSeconds: p.clientCooldownSeconds,
                        clientMaxImageSize: p.clientMaxImageSize,
                        clientImageQuality: p.clientImageQuality,
                        clientWindowPerMin: p.clientWindowPerMin,
                        clientChatMinIntervalSeconds: p.clientChatMinIntervalSeconds,
                        supabaseUrl: p.supabaseUrl ?? "",
                        supabaseAnonKey: e.target.value,
                      };
                      setWorkingConfig(newConfig);
                      setHasChanges(true);
                    }}
                    placeholder={ct("messages.project_settings_api_anon_public", "项目 Settings → API → anon public", "Project Settings → API → anon public")}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                  />
                </div>
              </div>

              {/* Provider Name */}
              <div>
                <label className="block text-sm text-gray-700 mb-1">{ct("messages.provider_display_name", "模型提供商显示名称", "Provider Display Name")}</label>
                <input
                  type="text"
                  value={workingConfig.cloudAIConfig?.providerName || ""}
                  onChange={(e) => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    const p = newConfig.cloudAIConfig || {};
                    newConfig.cloudAIConfig = {
                      enabled: p.enabled ?? false,
                      providerName: e.target.value,
                      edgeFunctionName: p.edgeFunctionName ?? "ai-vision-proxy",
                      modelId: p.modelId ?? "",
                      systemPrompt: p.systemPrompt ?? "",
                      maxTokens: p.maxTokens ?? 512,
                      clientDailyLimit: p.clientDailyLimit,
                      clientCooldownSeconds: p.clientCooldownSeconds,
                      clientMaxImageSize: p.clientMaxImageSize,
                      clientImageQuality: p.clientImageQuality,
                      clientWindowPerMin: p.clientWindowPerMin,
                      clientChatMinIntervalSeconds: p.clientChatMinIntervalSeconds,
                      supabaseUrl: p.supabaseUrl ?? "",
                      supabaseAnonKey: p.supabaseAnonKey ?? "",
                      allowUnauthenticatedUse: p.allowUnauthenticatedUse ?? false,
                    };
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  placeholder={ct("messages.e_g_qwen_gemini_gpt_4o", "例如：通义千问、Gemini、GPT-4o", "e.g. Qwen, Gemini, GPT-4o")}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm"
                />
                <p className="mt-1 text-[11px] text-gray-400">{ct("messages.shown_in_ui_so_users_know_which_ai", "用于UI显示，让用户知道使用的是哪个AI模型", "Shown in UI so users know which AI model is used")}</p>
              </div>

              {/* Edge Function Name */}
              <div>
                <label className="block text-sm text-gray-700 mb-1">{ct("messages.edge_function_name", "Edge Function 名称", "Edge Function Name")}</label>
                <input
                  type="text"
                  value={workingConfig.cloudAIConfig?.edgeFunctionName || "ai-vision-proxy"}
                  onChange={(e) => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    const p = newConfig.cloudAIConfig || {};
                    newConfig.cloudAIConfig = {
                      enabled: p.enabled ?? false,
                      providerName: p.providerName ?? "",
                      edgeFunctionName: e.target.value,
                      modelId: p.modelId ?? "",
                      systemPrompt: p.systemPrompt ?? "",
                      maxTokens: p.maxTokens ?? 512,
                      clientDailyLimit: p.clientDailyLimit,
                      clientCooldownSeconds: p.clientCooldownSeconds,
                      clientMaxImageSize: p.clientMaxImageSize,
                      clientImageQuality: p.clientImageQuality,
                      clientWindowPerMin: p.clientWindowPerMin,
                      clientChatMinIntervalSeconds: p.clientChatMinIntervalSeconds,
                      supabaseUrl: p.supabaseUrl ?? "",
                      supabaseAnonKey: p.supabaseAnonKey ?? "",
                      allowUnauthenticatedUse: p.allowUnauthenticatedUse ?? false,
                    };
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  placeholder="ai-vision-proxy"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                />
                <p className="mt-1 text-[11px] text-gray-400">{ct("messages.supabase_edge_function_name_maps_to_supabase_functions", "Supabase Edge Function 名称，对应 supabase/functions/ai-vision-proxy/index.ts", "Supabase Edge Function name, maps to supabase/functions/ai-vision-proxy/index.ts")}</p>
              </div>

              {/* Model ID */}
              <div>
                <label className="block text-sm text-gray-700 mb-1">{ct("messages.model_id", "模型标识 (Model ID)", "Model ID")}</label>
                <input
                  type="text"
                  value={workingConfig.cloudAIConfig?.modelId || ""}
                  onChange={(e) => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    const p = newConfig.cloudAIConfig || {};
                    newConfig.cloudAIConfig = {
                      enabled: p.enabled ?? false,
                      providerName: p.providerName ?? "",
                      edgeFunctionName: p.edgeFunctionName ?? "ai-vision-proxy",
                      modelId: e.target.value,
                      systemPrompt: p.systemPrompt ?? "",
                      maxTokens: p.maxTokens ?? 512,
                      clientDailyLimit: p.clientDailyLimit,
                      clientCooldownSeconds: p.clientCooldownSeconds,
                      clientMaxImageSize: p.clientMaxImageSize,
                      clientImageQuality: p.clientImageQuality,
                      clientWindowPerMin: p.clientWindowPerMin,
                      clientChatMinIntervalSeconds: p.clientChatMinIntervalSeconds,
                      supabaseUrl: p.supabaseUrl ?? "",
                      supabaseAnonKey: p.supabaseAnonKey ?? "",
                      allowUnauthenticatedUse: p.allowUnauthenticatedUse ?? false,
                    };
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  placeholder={ct("messages.e_g_qwen_vl_plus_gemini_2_0", "例如：qwen-vl-plus, gemini-2.0-flash, gpt-4o", "e.g. qwen-vl-plus, gemini-2.0-flash, gpt-4o")}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                />
                <p className="mt-1 text-[11px] text-gray-400">{ct("messages.passed_to_edge_function_which_routes_to_the", "传给 Edge Function 的模型标识，由 Edge Function 路由到对应的 API", "Passed to Edge Function, which routes to the correct provider API")}</p>
              </div>

              {/* System Prompt */}
              <div>
                <label className="block text-sm text-gray-700 mb-1">{ct("messages.system_prompt", "系统提示词 (System Prompt)", "System Prompt")}</label>
                <textarea
                  value={workingConfig.cloudAIConfig?.systemPrompt || ""}
                  onChange={(e) => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    const p = newConfig.cloudAIConfig || {};
                    newConfig.cloudAIConfig = {
                      enabled: p.enabled ?? false,
                      providerName: p.providerName ?? "",
                      edgeFunctionName: p.edgeFunctionName ?? "ai-vision-proxy",
                      modelId: p.modelId ?? "",
                      systemPrompt: e.target.value,
                      maxTokens: p.maxTokens ?? 512,
                      clientDailyLimit: p.clientDailyLimit,
                      clientCooldownSeconds: p.clientCooldownSeconds,
                      clientMaxImageSize: p.clientMaxImageSize,
                      clientImageQuality: p.clientImageQuality,
                      clientWindowPerMin: p.clientWindowPerMin,
                      clientChatMinIntervalSeconds: p.clientChatMinIntervalSeconds,
                      supabaseUrl: p.supabaseUrl ?? "",
                      supabaseAnonKey: p.supabaseAnonKey ?? "",
                      allowUnauthenticatedUse: p.allowUnauthenticatedUse ?? false,
                    };
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  rows={4}
                  placeholder={ct("messages.you_are_an_agricultural_pest_disease_expert_analyze", "你是一个农业病虫害专家。请分析图片中的作物病虫害情况，给出详细的诊断、严重程度评估和防治建议...", "You are an agricultural pest & disease expert. Analyze the crop image, provide detailed diagnosis, severity assessment, and treatment recommendations...")}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-xs"
                />
                <p className="mt-1 text-[11px] text-gray-400">{ct("messages.customize_the_system_prompt_for_specific_crops_or", "自定义系统提示词，可针对特定作物或地区调整分析侧重点。留空则使用Edge Function默认提示词", "Customize the system prompt for specific crops or regions. Leave empty to use Edge Function defaults")}</p>
              </div>

              {/* Max Tokens */}
              <div>
                <label className="block text-sm text-gray-700 mb-1">{ct("messages.max_output_tokens", "最大输出长度 (Max Tokens)", "Max Output Tokens")}</label>
                <input
                  type="number"
                  value={workingConfig.cloudAIConfig?.maxTokens || 512}
                  onChange={(e) => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    const p = newConfig.cloudAIConfig || {};
                    newConfig.cloudAIConfig = {
                      enabled: p.enabled ?? false,
                      providerName: p.providerName ?? "",
                      edgeFunctionName: p.edgeFunctionName ?? "ai-vision-proxy",
                      modelId: p.modelId ?? "",
                      systemPrompt: p.systemPrompt ?? "",
                      maxTokens: parseInt(e.target.value) || 512,
                      clientDailyLimit: p.clientDailyLimit,
                      clientCooldownSeconds: p.clientCooldownSeconds,
                      clientMaxImageSize: p.clientMaxImageSize,
                      clientImageQuality: p.clientImageQuality,
                      clientWindowPerMin: p.clientWindowPerMin,
                      clientChatMinIntervalSeconds: p.clientChatMinIntervalSeconds,
                      supabaseUrl: p.supabaseUrl ?? "",
                      supabaseAnonKey: p.supabaseAnonKey ?? "",
                      allowUnauthenticatedUse: p.allowUnauthenticatedUse ?? false,
                    };
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  min={128}
                  max={4096}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-sm"
                />
                <p className="mt-1 text-[11px] text-gray-400">{ct("messages.controls_the_length_of_ai_generated_reports_recommended", "控制AI生成的分析报告长度，建议 512-2048", "Controls the length of AI-generated reports. Recommended: 512-2048")}</p>
              </div>

              {/* Client-side rate limits (optional overrides) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-gray-100">
                <div>
                  <label className="block text-sm text-gray-700 mb-1">{ct("messages.client_daily_call_limit", "前端日调用上限", "Client daily call limit")}</label>
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={workingConfig.cloudAIConfig?.clientDailyLimit ?? ""}
                    placeholder="15"
                    onChange={(e) => {
                      const newConfig = JSON.parse(JSON.stringify(workingConfig));
                      const p = newConfig.cloudAIConfig || {};
                      const raw = e.target.value;
                      newConfig.cloudAIConfig = {
                        enabled: p.enabled ?? false,
                        providerName: p.providerName ?? "",
                        edgeFunctionName: p.edgeFunctionName ?? "ai-vision-proxy",
                        modelId: p.modelId ?? "",
                        systemPrompt: p.systemPrompt ?? "",
                        maxTokens: p.maxTokens ?? 512,
                        clientDailyLimit: raw === "" ? undefined : Math.min(999, Math.max(1, parseInt(raw, 10) || 0)),
                        clientCooldownSeconds: p.clientCooldownSeconds,
                        clientMaxImageSize: p.clientMaxImageSize,
                        clientImageQuality: p.clientImageQuality,
                        clientWindowPerMin: p.clientWindowPerMin,
                        clientChatMinIntervalSeconds: p.clientChatMinIntervalSeconds,
                        supabaseUrl: p.supabaseUrl ?? "",
                        supabaseAnonKey: p.supabaseAnonKey ?? "",
                        allowUnauthenticatedUse: p.allowUnauthenticatedUse ?? false,
                      };
                      if (raw === "" || !newConfig.cloudAIConfig.clientDailyLimit) delete newConfig.cloudAIConfig.clientDailyLimit;
                      setWorkingConfig(newConfig);
                      setHasChanges(true);
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <p className="mt-1 text-[11px] text-gray-400">{ct("messages.leave_empty_for_built_in_default_15_day", "留空使用内置默认（约 15 次/天）", "Leave empty for built-in default (~15/day)")}</p>
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">{ct("messages.min_interval_seconds", "调用间隔（秒）", "Min interval (seconds)")}</label>
                  <input
                    type="number"
                    min={0}
                    max={3600}
                    value={workingConfig.cloudAIConfig?.clientCooldownSeconds ?? ""}
                    placeholder="20"
                    onChange={(e) => {
                      const newConfig = JSON.parse(JSON.stringify(workingConfig));
                      const p = newConfig.cloudAIConfig || {};
                      const raw = e.target.value;
                      const v = raw === "" ? undefined : Math.min(3600, Math.max(0, parseInt(raw, 10) || 0));
                      newConfig.cloudAIConfig = {
                        enabled: p.enabled ?? false,
                        providerName: p.providerName ?? "",
                        edgeFunctionName: p.edgeFunctionName ?? "ai-vision-proxy",
                        modelId: p.modelId ?? "",
                        systemPrompt: p.systemPrompt ?? "",
                        maxTokens: p.maxTokens ?? 512,
                        clientDailyLimit: p.clientDailyLimit,
                        clientCooldownSeconds: v,
                        clientMaxImageSize: p.clientMaxImageSize,
                        clientImageQuality: p.clientImageQuality,
                        clientWindowPerMin: p.clientWindowPerMin,
                        clientChatMinIntervalSeconds: p.clientChatMinIntervalSeconds,
                        supabaseUrl: p.supabaseUrl ?? "",
                        supabaseAnonKey: p.supabaseAnonKey ?? "",
                        allowUnauthenticatedUse: p.allowUnauthenticatedUse ?? false,
                      };
                      if (raw === "" || newConfig.cloudAIConfig.clientCooldownSeconds === undefined) delete newConfig.cloudAIConfig.clientCooldownSeconds;
                      setWorkingConfig(newConfig);
                      setHasChanges(true);
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <p className="mt-1 text-[11px] text-gray-400">{ct("messages.leave_empty_for_built_in_default_20s", "留空使用内置默认（约 20 秒）", "Leave empty for built-in default (~20s)")}</p>
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">{ct("messages.max_requests_per_minute_window", "每分钟请求上限", "Max requests per minute (window)")}</label>
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={workingConfig.cloudAIConfig?.clientWindowPerMin ?? ""}
                    placeholder="6"
                    onChange={(e) => {
                      const newConfig = JSON.parse(JSON.stringify(workingConfig));
                      const p = newConfig.cloudAIConfig || {};
                      const raw = e.target.value;
                      const v = raw === "" ? undefined : Math.min(200, Math.max(1, parseInt(raw, 10) || 0));
                      newConfig.cloudAIConfig = {
                        enabled: p.enabled ?? false,
                        providerName: p.providerName ?? "",
                        edgeFunctionName: p.edgeFunctionName ?? "ai-vision-proxy",
                        modelId: p.modelId ?? "",
                        systemPrompt: p.systemPrompt ?? "",
                        maxTokens: p.maxTokens ?? 512,
                        clientDailyLimit: p.clientDailyLimit,
                        clientCooldownSeconds: p.clientCooldownSeconds,
                        clientMaxImageSize: p.clientMaxImageSize,
                        clientImageQuality: p.clientImageQuality,
                        clientWindowPerMin: v,
                        clientChatMinIntervalSeconds: p.clientChatMinIntervalSeconds,
                        supabaseUrl: p.supabaseUrl ?? "",
                        supabaseAnonKey: p.supabaseAnonKey ?? "",
                        allowUnauthenticatedUse: p.allowUnauthenticatedUse ?? false,
                      };
                      if (raw === "" || newConfig.cloudAIConfig.clientWindowPerMin === undefined) delete newConfig.cloudAIConfig.clientWindowPerMin;
                      setWorkingConfig(newConfig);
                      setHasChanges(true);
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <p className="mt-1 text-[11px] text-gray-400">{ct("messages.sliding_window_on_edge_empty_env_ai_rl", "Edge 滑动窗口；留空用环境 AI_RL_WINDOW_PER_MIN", "Sliding window on Edge; empty → env AI_RL_WINDOW_PER_MIN")}</p>
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">{ct("messages.global_ai_concurrent_limit", "全站并发上限（in-flight）", "Global AI concurrent limit (in-flight)")}</label>
                  <input
                    type="number"
                    min={5}
                    max={100}
                    value={workingConfig.cloudAIConfig?.clientMaxConcurrent ?? ""}
                    placeholder="100"
                    onChange={(e) => {
                      const newConfig = JSON.parse(JSON.stringify(workingConfig));
                      const p = newConfig.cloudAIConfig || {};
                      const raw = e.target.value;
                      const v = raw === "" ? undefined : Math.min(100, Math.max(5, parseInt(raw, 10) || 0));
                      newConfig.cloudAIConfig = {
                        enabled: p.enabled ?? false,
                        providerName: p.providerName ?? "",
                        edgeFunctionName: p.edgeFunctionName ?? "ai-vision-proxy",
                        modelId: p.modelId ?? "",
                        systemPrompt: p.systemPrompt ?? "",
                        maxTokens: p.maxTokens ?? 512,
                        clientDailyLimit: p.clientDailyLimit,
                        clientCooldownSeconds: p.clientCooldownSeconds,
                        clientMaxImageSize: p.clientMaxImageSize,
                        clientImageQuality: p.clientImageQuality,
                        clientWindowPerMin: p.clientWindowPerMin,
                        clientMaxConcurrent: v,
                        clientChatMinIntervalSeconds: p.clientChatMinIntervalSeconds,
                        supabaseUrl: p.supabaseUrl ?? "",
                        supabaseAnonKey: p.supabaseAnonKey ?? "",
                        allowUnauthenticatedUse: p.allowUnauthenticatedUse ?? false,
                      };
                      if (raw === "" || newConfig.cloudAIConfig.clientMaxConcurrent === undefined) {
                        delete newConfig.cloudAIConfig.clientMaxConcurrent;
                      }
                      setWorkingConfig(newConfig);
                      setHasChanges(true);
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <p className="mt-1 text-[11px] text-gray-400">{ct("messages.edge_clamps_5_100_empty_default_100", "Edge 限制 5–100；留空默认 100。CMS 生效有约 1 分钟缓存，宣讲前请提前改或改 Secret。", "Edge clamps 5–100; empty → 100. CMS changes may lag ~1 min; set Secret before peak events.")}</p>
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">{ct("messages.min_seconds_between_follow_up_sends", "追问最小间隔（秒）", "Min seconds between follow-up sends")}</label>
                  <input
                    type="number"
                    min={0}
                    max={3600}
                    value={workingConfig.cloudAIConfig?.clientChatMinIntervalSeconds ?? ""}
                    placeholder={ct("messages.same_as_min_interval", "同调用间隔", "Same as min interval")}
                    onChange={(e) => {
                      const newConfig = JSON.parse(JSON.stringify(workingConfig));
                      const p = newConfig.cloudAIConfig || {};
                      const raw = e.target.value;
                      const v = raw === "" ? undefined : Math.min(3600, Math.max(0, parseInt(raw, 10) || 0));
                      newConfig.cloudAIConfig = {
                        enabled: p.enabled ?? false,
                        providerName: p.providerName ?? "",
                        edgeFunctionName: p.edgeFunctionName ?? "ai-vision-proxy",
                        modelId: p.modelId ?? "",
                        systemPrompt: p.systemPrompt ?? "",
                        maxTokens: p.maxTokens ?? 512,
                        clientDailyLimit: p.clientDailyLimit,
                        clientCooldownSeconds: p.clientCooldownSeconds,
                        clientMaxImageSize: p.clientMaxImageSize,
                        clientImageQuality: p.clientImageQuality,
                        clientWindowPerMin: p.clientWindowPerMin,
                        clientChatMinIntervalSeconds: v,
                        supabaseUrl: p.supabaseUrl ?? "",
                        supabaseAnonKey: p.supabaseAnonKey ?? "",
                        allowUnauthenticatedUse: p.allowUnauthenticatedUse ?? false,
                      };
                      if (raw === "" || newConfig.cloudAIConfig.clientChatMinIntervalSeconds === undefined) {
                        delete newConfig.cloudAIConfig.clientChatMinIntervalSeconds;
                      }
                      setWorkingConfig(newConfig);
                      setHasChanges(true);
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <p className="mt-1 text-[11px] text-gray-400">{ct("messages.client_follow_up_spacing_only_empty_same_as", "仅前端追问连发；留空与「调用间隔」相同", "Client follow-up spacing only; empty → same as min interval")}</p>
                </div>
              </div>

              {/* Status indicator */}
              <div className="pt-3 border-t border-gray-100">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${
                    workingConfig.cloudAIConfig?.enabled
                      ? "bg-violet-500"
                      : "bg-gray-300"
                  }`} />
                  <span className="text-xs text-gray-600">
                    {workingConfig.cloudAIConfig?.enabled
                      ? ct(
                          `已启用 — ${workingConfig.cloudAIConfig?.providerName || "Cloud AI"} (${workingConfig.cloudAIConfig?.modelId || "未设置"})`,
                          `Enabled — ${workingConfig.cloudAIConfig?.providerName || "Cloud AI"} (${workingConfig.cloudAIConfig?.modelId || "not set"})`
                        )
                      : ct("messages.disabled_no_cloud_requests_no_mock_demo", "未启用（不请求云端，无 Mock 演示）", "Disabled (no cloud requests, no mock demo)")
                    }
                  </span>
                </div>
              </div>

              {/* Architecture + Security */}
              <div className="bg-violet-50 border border-violet-200 rounded-lg p-3 mt-3">
                <p className="text-xs text-violet-800 mb-2">{ct("messages.backend_proxy_architecture", "后端代理架构：", "Backend Proxy Architecture:")}</p>
                <div className="font-mono text-[10px] text-violet-600 space-y-1 bg-white rounded-lg p-3 border border-violet-100">
                  <p>{ct("messages.user_clicks_deep_analysis", "用户点击\"深度分析\"", "User clicks 'Deep Analysis'")}</p>
                  <p className="text-violet-400">{"  ↓ image + detection results"}</p>
                  <p>CloudAIService (fetch)</p>
                  <p className="text-violet-400">{"  ↓ POST /functions/v1/ai-vision-proxy"}</p>
                  <p className="text-violet-700">{ct("messages.supabase_edge_function", "Supabase Edge Function", "Supabase Edge Function")}</p>
                  <p className="text-violet-400">{"  ↓ QWEN_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY"}</p>
                  <p className="text-blue-600">{ct("messages.cloud_llm_api", "云端大模型 API", "Cloud LLM API")}</p>
                </div>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mt-3">
                <p className="text-xs text-amber-800 mb-2">{ct("messages.security_reminder", "安全提醒：", "Security Reminder:")}</p>
                <ul className="text-[11px] text-amber-700 space-y-1 list-disc list-inside">
                  <li>{ct("messages.all_cloud_ai_api_keys_qwen_api_key", "所有云AI的API密钥（如QWEN_API_KEY、GEMINI_API_KEY）必须作为Supabase Edge Function的Secrets配置", "All cloud AI API keys (QWEN_API_KEY, GEMINI_API_KEY, etc.) must be Supabase Edge Function Secrets")}</li>
                  <li>{ct("messages.this_config_only_stores_display_name_and_model", "此处只配置显示名称和模型标识，不涉及任何密钥", "This config only stores display name and model ID — no secrets involved")}</li>
                  <li>{ct("messages.enter_supabase_url_anon_key_above_for_cloud", "在上方填写云端识图专用 Supabase URL/Anon Key，或在 IM 后端代理页填写并留空此处（会回退使用，无需开启 IM）", "Enter Supabase URL/anon key above for cloud AI, or only under Backend Proxy and leave these empty (fallback; IM toggle not required)")}</li>
                </ul>
              </div>

              {/* Edge Function Template */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mt-3">
                <p className="text-xs text-blue-800 mb-2">{ct("messages.edge_function_deployment_reference", "Edge Function 部署参考：", "Edge Function Deployment Reference:")}</p>
                <ol className="text-[11px] text-blue-700 space-y-1 list-decimal list-inside">
                  <li>{ct("messages.create_supabase_functions_ai_vision_proxy_index_ts", "创建 supabase/functions/ai-vision-proxy/index.ts", "Create supabase/functions/ai-vision-proxy/index.ts")}</li>
                  <li>{ct("messages.read_secrets_via_deno_env_get_qwen_api", "在 Edge Function 中读取 Deno.env.get('QWEN_API_KEY') 等密钥", "Read secrets via Deno.env.get('QWEN_API_KEY') in the Edge Function")}</li>
                  <li>{ct("messages.receive_from_frontend", "接收前端传来的 { image, detections, modelId, systemPrompt, maxTokens }", "Receive { image, detections, modelId, systemPrompt, maxTokens } from frontend")}</li>
                  <li>{ct("messages.route_to_the_correct_cloud_api_based_on", "根据 modelId 路由到对应的云AI API（千问/Gemini/OpenAI）", "Route to the correct cloud API based on modelId (Qwen/Gemini/OpenAI)")}</li>
                  <li>{ct("messages.return", "返回 { analysis: '...markdown text...', confidence: 0.92, suggestions: [...] }", "Return { analysis: '...markdown text...', confidence: 0.92, suggestions: [...] }")}</li>
                </ol>
              </div>
            </div>
          </div>
        ) : activeTab === "backendProxy" ? (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-4">
              <h3 className="text-base text-gray-800 mb-2">{ct("messages.im_chat_config_supabase_realtime", "IM 通讯配置（Supabase Realtime）", "IM Chat Config (Supabase Realtime)")}</h3>
              <p className="text-xs text-gray-500 -mt-2">{ct("messages.this_app_uses_supabase_realtime_as_the_single", "本应用仅使用 Supabase Realtime 作为 IM 通道。密钥与 Service Role 保存在 Supabase 控制台（Project Settings / Edge Function Secrets），前端只读取公开的 URL 与 anon key。", "This app uses Supabase Realtime as the single IM channel. Keys and Service Role stay in the Supabase dashboard (Project Settings / Edge Function Secrets); the frontend only reads the public URL and anon key.")}</p>

              {/* Enable toggle */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700">{ct("messages.enable_supabase_realtime", "启用 Supabase Realtime", "Enable Supabase Realtime")}</span>
                <button
                  onClick={() => {
                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                    if (!newConfig.backendProxyConfig) newConfig.backendProxyConfig = emptyBackendProxyShell();
                    newConfig.backendProxyConfig.enabled = !newConfig.backendProxyConfig.enabled;
                    newConfig.backendProxyConfig.chatProvider = "supabase";
                    newConfig.backendProxyConfig.imMode = "im-provider-direct";
                    setWorkingConfig(newConfig);
                    setHasChanges(true);
                  }}
                  className={`relative w-12 h-6 rounded-full transition-colors ${
                    workingConfig.backendProxyConfig?.enabled ? "bg-emerald-500" : "bg-gray-300"
                  }`}
                >
                  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    workingConfig.backendProxyConfig?.enabled ? "translate-x-6" : "translate-x-0.5"
                  }`} />
                </button>
              </div>

              {/* Provider badge — Supabase only */}
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 border-emerald-400 bg-emerald-50 ring-2 ring-emerald-400">
                <span className="text-lg">{"⚡"}</span>
                <div>
                  <span className="text-sm text-gray-900">{ct("messages.supabase_realtime_single_im_provider", "Supabase Realtime（唯一 IM 提供商）", "Supabase Realtime (single IM provider)")}</span>
                  <p className="text-[11px] text-gray-500 mt-0.5">{ct("messages.postgres_realtime_storage_edge_functions_messages_media_and", "Postgres + Realtime + Storage + Edge Functions，消息、媒体、绑定全部走 Supabase。", "Postgres + Realtime + Storage + Edge Functions: messages, media, and bindings all flow through Supabase.")}</p>
                </div>
              </div>

              <div className="rounded-xl border border-emerald-200 bg-emerald-50/80 px-3 py-2 text-[11px] text-emerald-900">
                {ct("messages.deploy_edge_server_chat_supabase_merchant_bind_resolve", "部署 Edge：`server`、`chat-supabase`、`merchant-bind-resolve`、`ai-vision-proxy`；执行 SQL：`supabase/migrations/001_init.sql`；门店端二维码短链：https://你的域名/m/{merchant_user_id}", "Deploy Edge: server, chat-supabase, merchant-bind-resolve, ai-vision-proxy; run `supabase/migrations/001_init.sql`; merchant QR short link: https://your-domain/m/{merchant_user_id}")}
              </div>

              {/* Supabase Connection (for Token endpoint only) */}
              <div className="pt-3 border-t border-gray-200">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm text-gray-700">{ct("messages.supabase_connection_token_endpoint", "Supabase 连接（Token 端点）", "Supabase Connection (Token Endpoint)")}</h4>
                  <button
                    onClick={() => setActiveTab('supabase')}
                    className="text-xs text-emerald-600 hover:text-emerald-700 hover:underline transition-colors"
                  >
                    {ct("messages.go_to_config", "前往配置 →", "Go to config →")}
                  </button>
                </div>
                <div className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs ${
                  (workingConfig.backendProxyConfig?.supabaseUrl || '').startsWith('https://') && (workingConfig.backendProxyConfig?.supabaseAnonKey || '').length > 20
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                    : 'bg-gray-50 border-gray-200 text-gray-500'
                }`}>
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    (workingConfig.backendProxyConfig?.supabaseUrl || '').startsWith('https://') && (workingConfig.backendProxyConfig?.supabaseAnonKey || '').length > 20 ? 'bg-emerald-500' : 'bg-gray-300'
                  }`} />
                  <span className="truncate font-mono">{workingConfig.backendProxyConfig?.supabaseUrl || ct("messages.not_configured", "未配置", "Not configured")}</span>
                </div>
                <p className="mt-2 text-[11px] text-gray-400">{ct("messages.supabase_powers_the_realtime_message_channel_storage_media", "Supabase 同时承载 Realtime 消息通道、Storage 媒体、Edge Functions（chat-supabase / merchant-bind-resolve / server / ai-vision-proxy）。", "Supabase powers the Realtime message channel, Storage media, and Edge Functions (chat-supabase / merchant-bind-resolve / server / ai-vision-proxy).")}</p>
              </div>

              {/* Status indicator */}
              <div className="pt-3 border-t border-gray-100">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${
                    (workingConfig.backendProxyConfig?.enabled && workingConfig.backendProxyConfig?.supabaseUrl?.startsWith("https://"))
                      ? "bg-emerald-500"
                      : workingConfig.backendProxyConfig?.enabled
                        ? "bg-amber-500"
                        : "bg-gray-300"
                  }`} />
                  <span className="text-xs text-gray-600">
                    {workingConfig.backendProxyConfig?.enabled
                      ? (workingConfig.backendProxyConfig?.supabaseUrl?.startsWith("https://")
                          ? ct("messages.enabled_supabase_realtime", "已启用 — Supabase Realtime", "Enabled — Supabase Realtime")
                          : ct("messages.enabled_but_url_invalid_please_enter_correct_supabase", "已启用但 URL 无效，请填写正确的 Supabase URL", "Enabled but URL invalid, please enter correct Supabase URL"))
                      : ct("messages.disabled_mock_mode_chat_and_calls_are_simulated", "未启用（Mock 模式 — 聊天和通话仅在本地模拟）", "Disabled (Mock Mode — chat and calls are simulated locally)")
                    }
                  </span>
                </div>
              </div>

              {/* Architecture Diagram — Supabase Realtime */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 mt-3">
                <p className="text-xs text-gray-700 mb-3">{ct("messages.supabase_realtime_architecture", "Supabase Realtime 架构：", "Supabase Realtime Architecture:")}</p>
                <div className="font-mono text-[10px] text-gray-600 space-y-1 bg-white rounded-lg p-3 border border-gray-100">
                  <p>{ct("messages.frontend_communitypage_storecommunityshell", "前端 CommunityPage / StoreCommunityShell", "Frontend CommunityPage / StoreCommunityShell")}</p>
                  <p className="text-gray-400">{"  ↓ SupabaseChatAdapter"}</p>
                  <p className="text-emerald-600">{ct("messages.supabase_realtime_chat_messages_broadcast", "Supabase Realtime（chat_messages 广播）", "Supabase Realtime (chat_messages broadcast)")}</p>
                  <p className="text-gray-400">{"  ↕ WebSocket"}</p>
                  <p className="text-blue-600">{ct("messages.supabase_postgres_storage_edge_functions", "Supabase Postgres + Storage + Edge Functions", "Supabase Postgres + Storage + Edge Functions")}</p>
                  <p className="text-gray-300 mt-2">{"---"}</p>
                  <p className="text-gray-400">{ct("messages.qr_bind_flow", "二维码绑定流程：", "QR bind flow:")}</p>
                  <p className="text-gray-500">{ct("messages.store", "门店", "Store")} {"→"} /m/{"{merchant_user_id}"} {"→"} merchant-bind-resolve {"→"} farmer_merchant_bindings</p>
                </div>
              </div>

              {/* Security Notice */}
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mt-3">
                <p className="text-xs text-amber-800 mb-2">{ct("messages.security_reminder", "安全提醒：", "Security Reminder:")}</p>
                <ul className="text-[11px] text-amber-700 space-y-1 list-disc list-inside">
                  <li>{ct("messages.service_role_key_only_lives_in_supabase_edge", "Service Role Key 只保存在 Supabase Edge Function Secrets，绝不放在前端。", "Service Role Key only lives in Supabase Edge Function Secrets, never in the frontend.")}</li>
                  <li>{ct("messages.anon_key_is_public_browser_access_under_rls", "Anon Key 是公开的（仅 RLS 下的浏览器访问），在此配置无风险。", "Anon Key is public (browser access under RLS) and safe to configure here.")}</li>
                  <li>{ct("messages.rls_ensures_store_farmer_only_reads_their_own", "RLS 保证门店/农户只能读到与自己相关的 chat_messages / merchant_farmer_channels / farmer_merchant_bindings 行。", "RLS ensures store/farmer only reads their own rows in chat_messages / merchant_farmer_channels / farmer_merchant_bindings.")}</li>
                </ul>
              </div>

              {/* Setup Guide */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mt-3">
                <p className="text-xs text-blue-800 mb-2">{ct("messages.deployment_steps", "部署步骤：", "Deployment Steps:")}</p>
                <ol className="text-[11px] text-blue-700 space-y-1 list-decimal list-inside">
                  <li>{ct("messages.create_the_supabase_project_and_enable_auth_realtime", "在 Supabase 控制台建好项目，启用 Auth、Realtime、Storage。", "Create the Supabase project and enable Auth, Realtime, Storage.")}</li>
                  <li>{ct("messages.run_supabase_migrations_001_init_sql_single_file", "执行 supabase/migrations/001_init.sql（单文件库表 + RLS）。", "Run supabase/migrations/001_init.sql (single-file schema + RLS).")}</li>
                  <li>{ct("messages.deploy_edge_functions_via_supabase_deploy_functions_sh", "通过 supabase/deploy-functions.sh 部署 Edge：server、chat-supabase、merchant-bind-resolve、ai-vision-proxy。", "Deploy Edge Functions via supabase/deploy-functions.sh: server, chat-supabase, merchant-bind-resolve, ai-vision-proxy.")}</li>
                  <li>{ct("messages.fill_in_supabase_url_and_anon_key_above", "在上方填写 Supabase URL 与 Anon Key，然后开启启用开关。", "Fill in Supabase URL and Anon Key above, then toggle the Enable switch.")}</li>
                </ol>
              </div>
            </div>
          </div>
        ) : activeTab === "loginConfig" ? (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-4">
              <h3 className="text-base text-gray-800 mb-2">{ct("messages.login_page_config", "登录页面配置", "Login Page Config")}</h3>
              <p className="text-xs text-gray-500 -mt-2">{ct("messages.this_screen_only_toggles_which_buttons_appear_on", "此处仅控制登录页是否显示各入口。实际 OAuth / 短信等密钥请在 Supabase 项目控制台（Authentication → Providers 等）配置，无需在此填写。", "This screen only toggles which buttons appear on the login page. Configure OAuth keys and SMS in your Supabase project (Authentication → Providers, etc.) — nothing to fill in here.")}</p>

              {/* Social providers — visibility toggles only */}
              <div className="space-y-2">
                <h4 className="text-sm text-gray-700 font-medium flex items-center gap-2">
                  <Shield className="w-4 h-4 text-emerald-600" />
                  {ct("messages.social_login_show_hide", "社交登录（显示开关）", "Social login (show/hide)")}
                </h4>
                {([
                  { key: 'wechat' as const, label: ct("messages.wechat", "微信 WeChat", "WeChat"), color: "bg-[#07C160]", badge: 'WX' as const },
                  { key: 'google' as const, label: "Google", color: "bg-[#4285F4]", badge: 'G' as const },
                  { key: 'facebook' as const, label: "Facebook", color: "bg-[#1877F2]", badge: 'f' as const },
                  { key: 'apple' as const, label: "Apple", color: "bg-black", badge: 'A' as const },
                  { key: 'alipay' as const, label: ct("messages.alipay", "支付宝 Alipay", "Alipay"), color: "bg-[#1678FF]", badge: 'AP' as const },
                  { key: 'line' as const, label: ct("messages.line", "LINE", "LINE"), color: "bg-[#06C755]", badge: 'L' as const },
                  { key: 'twitter' as const, label: "X (Twitter)", color: "bg-black", badge: 'X' as const },
                ]).map((provider) => {
                  const isEnabled = workingConfig.loginConfig?.socialProviders?.[provider.key] !== false;

                  return (
                    <div key={provider.key} className={`border rounded-xl overflow-hidden transition-colors ${isEnabled ? 'border-gray-200' : 'border-gray-100 opacity-60'}`}>
                      <div className="flex items-center justify-between px-4 py-3 bg-gray-50/50">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <div className={`w-7 h-7 ${provider.color} rounded-lg flex items-center justify-center flex-shrink-0`}>
                            <span className="text-white text-[10px]">{provider.badge}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-gray-800">{provider.label}</span>
                            {isEnabled && (
                              <span className="ms-2 text-[10px] text-gray-400">
                                {ct("messages.shown_on_login", "登录页显示", "Shown on login")}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const newConfig = JSON.parse(JSON.stringify(workingConfig));
                            if (!newConfig.loginConfig) newConfig.loginConfig = { socialProviders: { wechat: true, google: true, facebook: true, apple: true, alipay: true, line: true, twitter: true }, oauthCredentials: {}, enablePhoneLogin: true, enableEmailLogin: true, defaultLoginMethod: 'phone' };
                            if (!newConfig.loginConfig.socialProviders) newConfig.loginConfig.socialProviders = { wechat: true, google: true, facebook: true, apple: true, alipay: true, twitter: true };
                            newConfig.loginConfig.socialProviders[provider.key] = !newConfig.loginConfig.socialProviders[provider.key];
                            setWorkingConfig(newConfig);
                            setHasChanges(true);
                          }}
                          className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${
                            isEnabled ? "bg-emerald-500" : "bg-gray-300"
                          }`}
                        >
                          <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                            isEnabled ? "translate-x-6" : "translate-x-0.5"
                          }`} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Regional OAuth Credentials — WeChat / Alipay / LINE (public, not a secret) */}
              {(['wechat', 'alipay', 'line'] as const).filter(k => workingConfig.loginConfig?.socialProviders?.[k] !== false).map(k => {
                const isLine = k === 'line';
                const fieldKey = isLine ? 'channelId' : 'appId';
                const label = k === 'wechat' ? ct("messages.wechat_app_id", "微信 AppID", "WeChat App ID") :
                              k === 'line' ? ct("messages.line_channel_id", "LINE Channel ID", "LINE Channel ID") :
                              ct("messages.alipay_app_id", "支付宝 AppID", "Alipay App ID");
                const hint = k === 'wechat'
                  ? ct("messages.wechat_open_platform_app_id_public_used_to", "微信开放平台的 AppID（公开信息，用于构造授权 URL）", "WeChat Open Platform App ID (public, used to build the OAuth URL)")
                  : k === 'line'
                    ? ct("messages.line_developers_console_channel_id_public_used_to", "LINE Developers Console 的 Channel ID（公开信息，用于构造授权 URL）", "LINE Developers Console Channel ID (public, used to build the OAuth URL)")
                    : ct("messages.alipay_open_platform_app_id_public", "支付宝开放平台的 AppID（公开信息）", "Alipay Open Platform App ID (public)");
                const placeholder = k === 'wechat' ? 'wxXXXXXXXXXXXXXXXX' : k === 'line' ? '1XXXXXXXXX' : '2021XXXXXXXXXXXX';

                return (
                <div key={`oauth-${k}`} className="pt-3 border-t border-gray-200 space-y-2">
                  <h4 className="text-sm text-gray-700 font-medium">{label}</h4>
                  <p className="text-[11px] text-gray-400">{hint}</p>
                  <input
                    type="text"
                    value={(workingConfig.loginConfig?.oauthCredentials?.[k] as any)?.[fieldKey] || ''}
                    onChange={(e) => {
                      const newConfig = JSON.parse(JSON.stringify(workingConfig));
                      if (!newConfig.loginConfig) newConfig.loginConfig = { socialProviders: { wechat: true, google: true, facebook: true, apple: true, alipay: true, line: true, twitter: true }, oauthCredentials: {}, enablePhoneLogin: true, enableEmailLogin: true, defaultLoginMethod: 'phone' };
                      if (!newConfig.loginConfig.oauthCredentials) newConfig.loginConfig.oauthCredentials = {};
                      if (!newConfig.loginConfig.oauthCredentials[k]) newConfig.loginConfig.oauthCredentials[k] = isLine ? { channelId: '' } : { appId: '' };
                      (newConfig.loginConfig.oauthCredentials[k] as any)[fieldKey] = e.target.value;
                      setWorkingConfig(newConfig);
                      setHasChanges(true);
                    }}
                    placeholder={placeholder}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                  />
                </div>
                );
              })}

              {/* Account Login Methods */}
              <div className="space-y-3 pt-3 border-t border-gray-200">
                <h4 className="text-sm text-gray-700 font-medium">{ct("messages.account_login_methods", "账号登录方式", "Account Login Methods")}</h4>

                {/* Phone Login Toggle */}
                <div className="flex items-center justify-between py-2">
                  <div>
                    <label className="block text-sm text-gray-700">{ct("messages.phone_login", "手机号登录", "Phone Login")}</label>
                    <p className="text-[11px] text-gray-400">{ct("messages.login_via_phone_number_verification_code", "通过手机号 + 验证码登录", "Login via phone number + verification code")}</p>
                  </div>
                  <button
                    onClick={() => {
                      const newConfig = JSON.parse(JSON.stringify(workingConfig));
                      if (!newConfig.loginConfig) newConfig.loginConfig = { socialProviders: { wechat: true, google: true, facebook: true, apple: true, alipay: true, line: true, twitter: true }, oauthCredentials: {}, enablePhoneLogin: true, enableEmailLogin: true, defaultLoginMethod: 'phone' };
                      newConfig.loginConfig.enablePhoneLogin = !newConfig.loginConfig.enablePhoneLogin;
                      if (!newConfig.loginConfig.enablePhoneLogin && newConfig.loginConfig.defaultLoginMethod === 'phone') {
                        newConfig.loginConfig.defaultLoginMethod = 'email';
                      }
                      setWorkingConfig(newConfig);
                      setHasChanges(true);
                    }}
                    className={`relative w-12 h-6 rounded-full transition-colors ${
                      workingConfig.loginConfig?.enablePhoneLogin !== false ? "bg-emerald-500" : "bg-gray-300"
                    }`}
                  >
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                      workingConfig.loginConfig?.enablePhoneLogin !== false ? "translate-x-6" : "translate-x-0.5"
                    }`} />
                  </button>
                </div>

                {/* Email Login Toggle */}
                <div className="flex items-center justify-between py-2">
                  <div>
                    <label className="block text-sm text-gray-700">{ct("messages.email_login", "邮箱登录", "Email Login")}</label>
                    <p className="text-[11px] text-gray-400">{ct("messages.login_via_email_verification_code", "通过邮箱 + 验证码登录", "Login via email + verification code")}</p>
                  </div>
                  <button
                    onClick={() => {
                      const newConfig = JSON.parse(JSON.stringify(workingConfig));
                      if (!newConfig.loginConfig) newConfig.loginConfig = { socialProviders: { wechat: true, google: true, facebook: true, apple: true, alipay: true, line: true, twitter: true }, oauthCredentials: {}, enablePhoneLogin: true, enableEmailLogin: true, defaultLoginMethod: 'phone' };
                      newConfig.loginConfig.enableEmailLogin = !newConfig.loginConfig.enableEmailLogin;
                      if (!newConfig.loginConfig.enableEmailLogin && newConfig.loginConfig.defaultLoginMethod === 'email') {
                        newConfig.loginConfig.defaultLoginMethod = 'phone';
                      }
                      setWorkingConfig(newConfig);
                      setHasChanges(true);
                    }}
                    className={`relative w-12 h-6 rounded-full transition-colors ${
                      workingConfig.loginConfig?.enableEmailLogin !== false ? "bg-emerald-500" : "bg-gray-300"
                    }`}
                  >
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                      workingConfig.loginConfig?.enableEmailLogin !== false ? "translate-x-6" : "translate-x-0.5"
                    }`} />
                  </button>
                </div>

                {/* Default Login Method */}
                <div className="pt-2">
                  <label className="block text-sm text-gray-700 mb-1">{ct("messages.default_login_method", "默认登录方式", "Default Login Method")}</label>
                  <div className="flex gap-2">
                    {[
                      { key: 'phone' as const, label: ct("messages.phone", "手机号", "Phone") },
                      { key: 'email' as const, label: ct("messages.email", "邮箱", "Email") }
                    ].map(method => (
                      <button
                        key={method.key}
                        onClick={() => {
                          const newConfig = JSON.parse(JSON.stringify(workingConfig));
                          if (!newConfig.loginConfig) newConfig.loginConfig = { socialProviders: { wechat: true, google: true, facebook: true, apple: true, alipay: true, line: true, twitter: true }, oauthCredentials: {}, enablePhoneLogin: true, enableEmailLogin: true, defaultLoginMethod: 'phone' };
                          newConfig.loginConfig.defaultLoginMethod = method.key;
                          setWorkingConfig(newConfig);
                          setHasChanges(true);
                        }}
                        className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                          (workingConfig.loginConfig?.defaultLoginMethod || 'phone') === method.key
                            ? "bg-emerald-600 text-white"
                            : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                        }`}
                      >
                        {method.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-gray-400">{ct("messages.the_login_method_selected_by_default_when_the", "用户打开登录页时默认选中的登录方式", "The login method selected by default when the user opens the login page")}</p>
                </div>
              </div>

              {/* Preview Info */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mt-3">
                <p className="text-xs text-blue-800 mb-2">{ct("messages.current_preview", "当前预览：", "Current Preview:")}</p>
                <div className="text-[11px] text-blue-700 space-y-1">
                  <p>{ct("messages.social_login_shown", "社交登录（将显示）：", "Social login (shown): ")}
                    {(['wechat', 'google', 'facebook', 'apple', 'alipay', 'line', 'twitter'] as const)
                      .filter(k => workingConfig.loginConfig?.socialProviders?.[k] !== false)
                      .map(k => ({ wechat: 'WeChat', google: 'Google', facebook: 'Facebook', apple: 'Apple', alipay: 'Alipay', line: 'LINE', twitter: 'X' }[k]))
                      .join(', ') || ct("messages.none", "无", "None")}
                  </p>
                  <p>{ct("messages.account_login", "账号登录：", "Account Login: ")}
                    {[
                      workingConfig.loginConfig?.enablePhoneLogin !== false ? ct("messages.phone", "手机号", "Phone") : null,
                      workingConfig.loginConfig?.enableEmailLogin !== false ? ct("messages.email", "邮箱", "Email") : null
                    ].filter(Boolean).join(', ') || ct("messages.none", "无", "None")}
                  </p>
                  <p className="text-[10px] text-blue-500 mt-1">{ct("messages.whether_login_works_depends_on_providers_being_enabled", "实际能否登录取决于 Supabase 控制台是否已启用对应 Provider。", "Whether login works depends on providers being enabled in the Supabase Dashboard.")}</p>
                </div>
              </div>

              {/* Security & Deployment Note */}
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mt-3">
                <p className="text-xs text-amber-800 mb-2 flex items-center gap-1">
                  <Shield className="w-3.5 h-3.5" />
                  {ct("messages.security_deployment_reminder", "安全与部署提醒：", "Security & Deployment Reminder:")}
                </p>
                <ul className="text-[11px] text-amber-700 space-y-1 list-disc list-inside">
                  <li>{ct("messages.for_google_facebook_apple_x_set_client_id", "Google / Facebook / Apple / X 等：在 Supabase → Authentication → Providers 中填写 Client ID 与 Secret；前端仅通过 Supabase 发起登录，不在此配置页保存密钥。", "For Google / Facebook / Apple / X: set Client ID and Secret in Supabase → Authentication → Providers. The app signs in via Supabase only; no secrets are stored in this config page.")}</li>
                  <li>{ct("messages.wechat_alipay_line_configure_wechat_alipay_line_channel", "微信 / 支付宝 / LINE：在 Supabase Edge Function Secrets（如 WECHAT_*、ALIPAY_*、LINE_CHANNEL_*）中配置；本页只控制是否显示按钮。", "WeChat / Alipay / LINE: configure WECHAT_* / ALIPAY_* / LINE_CHANNEL_* in Edge Function secrets; this page only toggles button visibility.")}</li>
                  <li>{ct("messages.enable_only_login_methods_common_in_your_target", "建议只启用目标市场常用的登录方式（如国内市场：微信+手机号；海外市场：Google+Apple+邮箱）", "Enable only login methods common in your target market (e.g. China: WeChat + phone; international: Google + Apple + email)")}</li>
                </ul>
              </div>
            </div>
          </div>
        ) : activeTab === "pushProviders" ? (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-4">
              <h3 className="text-base text-gray-800 mb-2">{ct("messages.push_notification_provider_config", "推送服务商配置", "Push Notification Provider Config")}</h3>
              <p className="text-xs text-gray-500 -mt-2">{ct("messages.select_and_configure_push_notification_providers_public_keys", "选择并配置推送通知服务商。公钥/App ID 放在前端安全使用，私钥/Master Secret 必须存放在后端（Edge Function Secrets）。同一时间只激活一个服务商。", "Select and configure push notification providers. Public keys/App IDs are safe for frontend. Private keys/Master Secrets must be stored server-side (Edge Function Secrets). Only one provider is active at a time.")}</p>

              {/* Provider Cards */}
              <div className="space-y-3">
                {([
                  {
                    key: 'webpush' as const,
                    name: 'Web Push (VAPID)',
                    icon: '🌐',
                    color: 'border-blue-400 bg-blue-50',
                    activeColor: 'ring-blue-400',
                    desc: ct("messages.w3c_standard_no_third_party_sdk_native_browser", "W3C标准，无需第三方SDK，浏览器原生支持", "W3C standard, no third-party SDK, native browser support"),
                    region: ct("messages.global", "全球", "Global"),
                  },
                  {
                    key: 'fcm' as const,
                    name: 'Firebase Cloud Messaging',
                    icon: '🔥',
                    color: 'border-orange-400 bg-orange-50',
                    activeColor: 'ring-orange-400',
                    desc: ct("messages.google_push_service_free_unlimited_supports_web_ios", "Google推送服务，免费无限量，支持Web/iOS/Android", "Google push service, free unlimited, supports Web/iOS/Android"),
                    region: ct("messages.global_not_available_in_mainland_china", "全球（中国大陆不可用）", "Global (not available in mainland China)"),
                  },
                  {
                    key: 'onesignal' as const,
                    name: 'OneSignal',
                    icon: '📡',
                    color: 'border-purple-400 bg-purple-50',
                    activeColor: 'ring-purple-400',
                    desc: ct("messages.professional_push_platform_generous_free_tier_auto_segmentation", "专业推送平台，免费额度大，自动分段推送", "Professional push platform, generous free tier, auto-segmentation"),
                    region: ct("messages.global", "全球", "Global"),
                  },
                  {
                    key: 'jpush' as const,
                    name: ct("messages.jpush", "极光推送 JPush", "JPush"),
                    icon: '⚡',
                    color: 'border-yellow-400 bg-yellow-50',
                    activeColor: 'ring-yellow-400',
                    desc: ct("messages.china_mainstream_push_supports_vendor_channels_huawei_xiaomi", "国内主流推送，支持厂商通道（华为/小米/OPPO/vivo），送达率高", "China mainstream push, supports vendor channels (Huawei/Xiaomi/OPPO/vivo), high delivery rate"),
                    region: ct("messages.china_1", "中国", "China"),
                  },
                  {
                    key: 'getui' as const,
                    name: ct("messages.getui_unipush", "个推 GeTui / UniPush", "GeTui / UniPush"),
                    icon: '📱',
                    color: 'border-green-400 bg-green-50',
                    activeColor: 'ring-green-400',
                    desc: ct("messages.china_top3_push_provider_billions_of_daily_pushes", "国内TOP3推送服务商，日均推送百亿级，支持统一推送联盟", "China TOP3 push provider, billions of daily pushes, supports Unified Push Alliance"),
                    region: ct("messages.china_1", "中国", "China"),
                  },
                ] as const).map((provider) => {
                  const pc = workingConfig.pushProvidersConfig || {};
                  const isActive = (pc.activeProvider || 'webpush') === provider.key;
                  const providerConfig = pc[provider.key] || {};
                  const isEnabled = providerConfig.enabled === true;

                  return (
                    <div key={provider.key} className={`border-2 rounded-xl overflow-hidden transition-all ${
                      isActive ? `${provider.color} ${provider.activeColor} ring-2` : 'border-gray-200 bg-white'
                    }`}>
                      {/* Header */}
                      <div className="flex items-center justify-between px-4 py-3">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <span className="text-xl">{provider.icon}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm text-gray-800">{provider.name}</span>
                              <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{provider.region}</span>
                              {isActive && (
                                <span className="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">{ct("messages.active", "已激活", "Active")}</span>
                              )}
                            </div>
                            <p className="text-[11px] text-gray-500 mt-0.5">{provider.desc}</p>
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            const newConfig = JSON.parse(JSON.stringify(workingConfig));
                            if (!newConfig.pushProvidersConfig) newConfig.pushProvidersConfig = {};
                            newConfig.pushProvidersConfig.activeProvider = provider.key;
                            if (!newConfig.pushProvidersConfig[provider.key]) newConfig.pushProvidersConfig[provider.key] = {};
                            newConfig.pushProvidersConfig[provider.key].enabled = true;
                            setWorkingConfig(newConfig);
                            setHasChanges(true);
                          }}
                          className={`px-3 py-1.5 rounded-lg text-xs transition-colors flex-shrink-0 ${
                            isActive
                              ? "bg-emerald-600 text-white"
                              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                          }`}
                        >
                          {isActive ? ct("messages.in_use", "当前使用", "In Use") : ct("messages.activate", "激活", "Activate")}
                        </button>
                      </div>

                      {/* Config Fields — only show when active */}
                      {isActive && (
                        <div className="px-4 py-3 bg-white/80 border-t border-gray-100 space-y-3">
                          {/* Web Push */}
                          {provider.key === 'webpush' && (
                            <>
                              <div>
                                <label className="block text-xs text-gray-600 mb-1">VAPID Public Key</label>
                                <input
                                  type="text"
                                  value={pc.webpush?.vapidPublicKey || ""}
                                  onChange={(e) => {
                                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                                    if (!newConfig.pushProvidersConfig) newConfig.pushProvidersConfig = {};
                                    if (!newConfig.pushProvidersConfig.webpush) newConfig.pushProvidersConfig.webpush = { enabled: true };
                                    newConfig.pushProvidersConfig.webpush.vapidPublicKey = e.target.value;
                                    setWorkingConfig(newConfig);
                                    setHasChanges(true);
                                  }}
                                  placeholder="BEl62iUYgUivxIk..."
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                                />
                                <p className="mt-1 text-[11px] text-gray-400">{ct("messages.generate_with_web_push_generate_vapid_keys_put", "用 web-push generate-vapid-keys 生成，公钥放这里", "Generate with web-push generate-vapid-keys, put public key here")}</p>
                              </div>
                              <div>
                                <label className="block text-xs text-gray-600 mb-1">{ct("messages.push_api_base_url", "推送后端API地址", "Push API Base URL")}</label>
                                <input
                                  type="text"
                                  value={pc.webpush?.pushApiBase || ""}
                                  onChange={(e) => {
                                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                                    if (!newConfig.pushProvidersConfig) newConfig.pushProvidersConfig = {};
                                    if (!newConfig.pushProvidersConfig.webpush) newConfig.pushProvidersConfig.webpush = { enabled: true };
                                    newConfig.pushProvidersConfig.webpush.pushApiBase = e.target.value;
                                    setWorkingConfig(newConfig);
                                    setHasChanges(true);
                                  }}
                                  placeholder="https://api.example.com"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                                />
                              </div>
                            </>
                          )}

                          {/* FCM */}
                          {provider.key === 'fcm' && (
                            <>
                              {[
                                { field: 'apiKey', label: 'Firebase Web API Key', placeholder: 'AIzaSy...', hint: ct("messages.firebase_console_project_settings_web_api_key_public", "Firebase Console → 项目设置 → Web API Key（公开）", "Firebase Console → Project Settings → Web API Key (public)") },
                                { field: 'projectId', label: 'Firebase Project ID', placeholder: 'my-project-123', hint: '' },
                                { field: 'appId', label: 'Firebase App ID', placeholder: '1:123456789:web:abcdef', hint: '' },
                                { field: 'messagingSenderId', label: 'FCM Sender ID', placeholder: '123456789', hint: ct("messages.firebase_console_cloud_messaging_sender_id", "Firebase Console → 云消息传递 → 发件人ID", "Firebase Console → Cloud Messaging → Sender ID") },
                                { field: 'vapidKey', label: 'FCM Web Push VAPID Key', placeholder: 'BEl62iUY...', hint: ct("messages.firebase_console_cloud_messaging_web_push_certificate_key", "Firebase Console → 云消息传递 → Web Push 证书 → 密钥对", "Firebase Console → Cloud Messaging → Web Push certificate → Key Pair") },
                              ].map(({ field, label, placeholder, hint }) => (
                                <div key={field}>
                                  <label className="block text-xs text-gray-600 mb-1">{label}</label>
                                  <input
                                    type="text"
                                    value={(pc.fcm as any)?.[field] || ""}
                                    onChange={(e) => {
                                      const newConfig = JSON.parse(JSON.stringify(workingConfig));
                                      if (!newConfig.pushProvidersConfig) newConfig.pushProvidersConfig = {};
                                      if (!newConfig.pushProvidersConfig.fcm) newConfig.pushProvidersConfig.fcm = { enabled: true };
                                      newConfig.pushProvidersConfig.fcm[field] = e.target.value;
                                      setWorkingConfig(newConfig);
                                      setHasChanges(true);
                                    }}
                                    placeholder={placeholder}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                                  />
                                  {hint && <p className="mt-1 text-[11px] text-gray-400">{hint}</p>}
                                </div>
                              ))}
                              <div className="bg-amber-50 rounded-lg p-2">
                                <p className="text-[11px] text-amber-700">{ct("messages.fcm_server_key_must_be_stored_server_side", "FCM Server Key 必须存放在后端（Supabase Edge Function Secrets），不要放在前端", "FCM Server Key must be stored server-side (Supabase Edge Function Secrets), never in frontend")}</p>
                              </div>
                            </>
                          )}

                          {/* OneSignal */}
                          {provider.key === 'onesignal' && (
                            <>
                              <div>
                                <label className="block text-xs text-gray-600 mb-1">OneSignal App ID</label>
                                <input
                                  type="text"
                                  value={pc.onesignal?.appId || ""}
                                  onChange={(e) => {
                                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                                    if (!newConfig.pushProvidersConfig) newConfig.pushProvidersConfig = {};
                                    if (!newConfig.pushProvidersConfig.onesignal) newConfig.pushProvidersConfig.onesignal = { enabled: true };
                                    newConfig.pushProvidersConfig.onesignal.appId = e.target.value;
                                    setWorkingConfig(newConfig);
                                    setHasChanges(true);
                                  }}
                                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                                />
                                <p className="mt-1 text-[11px] text-gray-400">{ct("messages.onesignal_dashboard_settings_keys_ids_onesignal_app_id", "OneSignal Dashboard → Settings → Keys & IDs → OneSignal App ID（公开）", "OneSignal Dashboard → Settings → Keys & IDs → OneSignal App ID (public)")}</p>
                              </div>
                              <div>
                                <label className="block text-xs text-gray-600 mb-1">Safari Web Push ID {ct("messages.optional", "（可选）", "(optional)")}</label>
                                <input
                                  type="text"
                                  value={pc.onesignal?.safariWebId || ""}
                                  onChange={(e) => {
                                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                                    if (!newConfig.pushProvidersConfig) newConfig.pushProvidersConfig = {};
                                    if (!newConfig.pushProvidersConfig.onesignal) newConfig.pushProvidersConfig.onesignal = { enabled: true };
                                    newConfig.pushProvidersConfig.onesignal.safariWebId = e.target.value;
                                    setWorkingConfig(newConfig);
                                    setHasChanges(true);
                                  }}
                                  placeholder="web.onesignal.auto.xxxxxx"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                                />
                              </div>
                              <div className="bg-amber-50 rounded-lg p-2">
                                <p className="text-[11px] text-amber-700">{ct("messages.onesignal_rest_api_key_must_be_stored_server", "OneSignal REST API Key 必须存放在后端（Edge Function Secrets），前端只放 App ID", "OneSignal REST API Key must be stored server-side (Edge Function Secrets). Only App ID goes in frontend.")}</p>
                              </div>
                            </>
                          )}

                          {/* JPush 极光推送 */}
                          {provider.key === 'jpush' && (
                            <>
                              <div>
                                <label className="block text-xs text-gray-600 mb-1">App Key {ct("messages.public", "（公开）", "(public)")}</label>
                                <input
                                  type="text"
                                  value={pc.jpush?.appKey || ""}
                                  onChange={(e) => {
                                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                                    if (!newConfig.pushProvidersConfig) newConfig.pushProvidersConfig = {};
                                    if (!newConfig.pushProvidersConfig.jpush) newConfig.pushProvidersConfig.jpush = { enabled: true };
                                    newConfig.pushProvidersConfig.jpush.appKey = e.target.value;
                                    setWorkingConfig(newConfig);
                                    setHasChanges(true);
                                  }}
                                  placeholder="your-jpush-app-key"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                                />
                                <p className="mt-1 text-[11px] text-gray-400">{ct("messages.jpush_console_app_settings_app_key", "极光控制台 → 应用设置 → App Key", "JPush Console → App Settings → App Key")}</p>
                              </div>
                              <div>
                                <label className="block text-xs text-gray-600 mb-1">{ct("messages.channel", "渠道标识", "Channel")}</label>
                                <input
                                  type="text"
                                  value={pc.jpush?.channel || ""}
                                  onChange={(e) => {
                                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                                    if (!newConfig.pushProvidersConfig) newConfig.pushProvidersConfig = {};
                                    if (!newConfig.pushProvidersConfig.jpush) newConfig.pushProvidersConfig.jpush = { enabled: true };
                                    newConfig.pushProvidersConfig.jpush.channel = e.target.value;
                                    setWorkingConfig(newConfig);
                                    setHasChanges(true);
                                  }}
                                  placeholder="default"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-xs"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-600 mb-1">{ct("messages.push_api_proxy_url", "推送API代理地址", "Push API Proxy URL")}</label>
                                <input
                                  type="text"
                                  value={pc.jpush?.pushApiBase || ""}
                                  onChange={(e) => {
                                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                                    if (!newConfig.pushProvidersConfig) newConfig.pushProvidersConfig = {};
                                    if (!newConfig.pushProvidersConfig.jpush) newConfig.pushProvidersConfig.jpush = { enabled: true };
                                    newConfig.pushProvidersConfig.jpush.pushApiBase = e.target.value;
                                    setWorkingConfig(newConfig);
                                    setHasChanges(true);
                                  }}
                                  placeholder="https://your-supabase.co/functions/v1/jpush-proxy"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                                />
                                <p className="mt-1 text-[11px] text-gray-400">{ct("messages.proxy_jpush_rest_api_via_supabase_edge_function", "通过Supabase Edge Function代理极光REST API", "Proxy JPush REST API via Supabase Edge Function")}</p>
                              </div>
                              <div className="bg-amber-50 rounded-lg p-2">
                                <p className="text-[11px] text-amber-700">{ct("messages.master_secret_must_be_stored_in_edge_function", "Master Secret 必须存放在后端 Edge Function Secrets 中（环境变量 JPUSH_MASTER_SECRET）", "Master Secret must be stored in Edge Function Secrets (env var JPUSH_MASTER_SECRET)")}</p>
                              </div>
                            </>
                          )}

                          {/* GeTui 个推 */}
                          {provider.key === 'getui' && (
                            <>
                              <div>
                                <label className="block text-xs text-gray-600 mb-1">App ID {ct("messages.public", "（公开）", "(public)")}</label>
                                <input
                                  type="text"
                                  value={pc.getui?.appId || ""}
                                  onChange={(e) => {
                                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                                    if (!newConfig.pushProvidersConfig) newConfig.pushProvidersConfig = {};
                                    if (!newConfig.pushProvidersConfig.getui) newConfig.pushProvidersConfig.getui = { enabled: true };
                                    newConfig.pushProvidersConfig.getui.appId = e.target.value;
                                    setWorkingConfig(newConfig);
                                    setHasChanges(true);
                                  }}
                                  placeholder="your-getui-app-id"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                                />
                                <p className="mt-1 text-[11px] text-gray-400">{ct("messages.getui_developer_center_app_config_app_id", "个推开发者中心 → 应用配置 → App ID", "GeTui Developer Center → App Config → App ID")}</p>
                              </div>
                              <div>
                                <label className="block text-xs text-gray-600 mb-1">App Key {ct("messages.public", "（公开）", "(public)")}</label>
                                <input
                                  type="text"
                                  value={pc.getui?.appKey || ""}
                                  onChange={(e) => {
                                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                                    if (!newConfig.pushProvidersConfig) newConfig.pushProvidersConfig = {};
                                    if (!newConfig.pushProvidersConfig.getui) newConfig.pushProvidersConfig.getui = { enabled: true };
                                    newConfig.pushProvidersConfig.getui.appKey = e.target.value;
                                    setWorkingConfig(newConfig);
                                    setHasChanges(true);
                                  }}
                                  placeholder="your-getui-app-key"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-600 mb-1">{ct("messages.push_api_proxy_url", "推送API代理地址", "Push API Proxy URL")}</label>
                                <input
                                  type="text"
                                  value={pc.getui?.pushApiBase || ""}
                                  onChange={(e) => {
                                    const newConfig = JSON.parse(JSON.stringify(workingConfig));
                                    if (!newConfig.pushProvidersConfig) newConfig.pushProvidersConfig = {};
                                    if (!newConfig.pushProvidersConfig.getui) newConfig.pushProvidersConfig.getui = { enabled: true };
                                    newConfig.pushProvidersConfig.getui.pushApiBase = e.target.value;
                                    setWorkingConfig(newConfig);
                                    setHasChanges(true);
                                  }}
                                  placeholder="https://your-supabase.co/functions/v1/getui-proxy"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                                />
                                <p className="mt-1 text-[11px] text-gray-400">{ct("messages.proxy_getui_rest_api_via_supabase_edge_function", "通过Supabase Edge Function代理个推REST API", "Proxy GeTui REST API via Supabase Edge Function")}</p>
                              </div>
                              <div className="bg-amber-50 rounded-lg p-2">
                                <p className="text-[11px] text-amber-700">{ct("messages.master_secret_must_be_stored_in_edge_function_1", "Master Secret 必须存放在后端 Edge Function Secrets 中（环境变量 GETUI_MASTER_SECRET）", "Master Secret must be stored in Edge Function Secrets (env var GETUI_MASTER_SECRET)")}</p>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Architecture Diagram */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 mt-3">
                <p className="text-xs text-gray-700 mb-2">{ct("messages.push_architecture", "推送架构：", "Push Architecture:")}</p>
                <div className="font-mono text-[10px] text-gray-600 space-y-1 bg-white rounded-lg p-3 border border-gray-100">
                  <p>{ct("messages.frontend_public_key_app_id_subscribe_user", "前端：公钥/App ID → 订阅用户", "Frontend: Public Key/App ID → Subscribe user")}</p>
                  <p className="text-gray-400">{"  ↓ subscription"}</p>
                  <p>{ct("messages.save_to_supabase_database_push_subscriptions_table", "存入 Supabase Database（push_subscriptions 表）", "Save to Supabase Database (push_subscriptions table)")}</p>
                  <p className="text-gray-400">{"  ↓ trigger / cron"}</p>
                  <p className="text-emerald-600">{ct("messages.edge_function_uses_private_key_master_secret", "Edge Function（使用私钥/Master Secret）", "Edge Function (uses Private Key/Master Secret)")}</p>
                  <p className="text-gray-400">{"  ↓ API call"}</p>
                  <p className="text-blue-600">{(() => {
                    const ap = workingConfig.pushProvidersConfig?.activeProvider || 'webpush';
                    const names: Record<string, string> = { webpush: 'Web Push API', fcm: 'FCM HTTP v1 API', onesignal: 'OneSignal REST API', jpush: ct("messages.jpush_rest_api_v3", "极光 REST API v3", "JPush REST API v3"), getui: ct("messages.getui_rest_api", "个推 REST API", "GeTui REST API") };
                    return names[ap] || 'Push API';
                  })()}</p>
                </div>
              </div>

              {/* Security Notice */}
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mt-3">
                <p className="text-xs text-amber-800 mb-2">{ct("messages.security_guidelines", "安全规范：", "Security Guidelines:")}</p>
                <ul className="text-[11px] text-amber-700 space-y-1 list-disc list-inside">
                  <li>{ct("messages.this_page_only_configures_public_identifiers_public_key", "此页面只配置公开标识（公钥、App ID、App Key），这些可以安全地暴露在前端代码中", "This page only configures public identifiers (Public Key, App ID, App Key) which are safe to expose in frontend code")}</li>
                  <li>{ct("messages.all_secrets_vapid_private_key_fcm_server_key", "所有私密凭证（VAPID Private Key、FCM Server Key、OneSignal REST API Key、极光 Master Secret、个推 Master Secret）必须存放在 Supabase Edge Function 的 Secrets 环境变量中", "All secrets (VAPID Private Key, FCM Server Key, OneSignal REST API Key, JPush Master Secret, GeTui Master Secret) must be stored in Supabase Edge Function Secrets")}</li>
                  <li>{ct("messages.push_send_requests_are_made_by_edge_functions", "推送发送请求由 Edge Function 发起，前端永远不接触私钥", "Push send requests are made by Edge Functions — frontend never touches private keys")}</li>
                </ul>
              </div>

              {/* Deployment Guide */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mt-3">
                <p className="text-xs text-blue-800 mb-2">{ct("messages.deployment_steps", "部署步骤：", "Deployment Steps:")}</p>
                <ol className="text-[11px] text-blue-700 space-y-1 list-decimal list-inside">
                  <li>{ct("messages.select_a_push_provider_above_and_fill_in", "在上方选择推送服务商并填写公钥/App ID", "Select a push provider above and fill in public key/App ID")}</li>
                  <li>{ct("messages.configure_the_corresponding_private_key_master_secret_in", "在 Supabase Edge Function Secrets 中配置对应的私钥/Master Secret", "Configure the corresponding private key/Master Secret in Supabase Edge Function Secrets")}</li>
                  <li>{ct("messages.deploy_edge_function_supabase_functions_deploy_push_proxy", "部署 Edge Function：supabase functions deploy push-proxy", "Deploy Edge Function: supabase functions deploy push-proxy")}</li>
                  <li>{ct("messages.create_push_subscriptions_table_in_supabase_database_to", "在 Supabase Database 中创建 push_subscriptions 表存储用户订阅信息", "Create push_subscriptions table in Supabase Database to store user subscriptions")}</li>
                  <li>{ct("messages.save_config_user_facing_app_will_auto_request", "保存配置，用户端会自动请求推送权限并订阅", "Save config — user-facing app will auto-request push permission and subscribe")}</li>
                </ol>
              </div>
            </div>
          </div>
        ) : activeTab === "pushNotification" ? (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-4">
              <h3 className="text-base text-gray-800 mb-2">{pushT("title")}</h3>
              <p className="text-xs text-gray-500 -mt-2">{pushT("description")}</p>

              <div className="rounded-lg border border-blue-100 bg-blue-50/70 p-3 text-[11px] text-blue-800 leading-relaxed flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-blue-600" />
                <span>{pushT("warningCaution")}</span>
              </div>

              {/* Title */}
              <div>
                <label className="block text-sm text-gray-700 mb-1">{pushT("notificationTitle")}</label>
                <input
                  type="text"
                  value={pushForm.title}
                  onChange={(e) => setPushForm((p) => ({ ...p, title: e.target.value }))}
                  placeholder={pushT("notificationTitlePlaceholder")}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </div>

              {/* Body */}
              <div>
                <label className="block text-sm text-gray-700 mb-1">{pushT("notificationBody")}</label>
                <textarea
                  value={pushForm.body}
                  onChange={(e) => setPushForm((p) => ({ ...p, body: e.target.value }))}
                  rows={4}
                  placeholder={pushT("notificationBodyPlaceholder")}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 resize-y"
                />
              </div>

              {/* Optional URL */}
              <div>
                <label className="block text-sm text-gray-700 mb-1">{pushT("notificationUrlLabel")}</label>
                <input
                  type="text"
                  value={pushForm.url}
                  onChange={(e) => setPushForm((p) => ({ ...p, url: e.target.value }))}
                  placeholder={pushT("notificationUrlPlaceholder")}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
                />
                <p className="text-[10px] text-gray-400 mt-1">{pushT("notificationUrlHint")}</p>
              </div>

              {/* Providers info */}
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-[11px] text-gray-600 space-y-1">
                <p className="font-medium text-gray-700">{pushT("channelsHeading")}</p>
                <p>{pushT("lineWebPush")}</p>
                <p>{pushT("lineFcm")}</p>
                <p>{pushT("lineJpush")}</p>
              </div>

              {/* Send button */}
              <button
                type="button"
                disabled={!pushForm.title.trim() || !pushForm.body.trim() || pushSendStatus === "sending"}
                onClick={() => setPushConfirmOpen(true)}
                className="w-full px-4 py-3 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 font-medium"
              >
                {pushSendStatus === "sending" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {pushT("sending")}
                  </>
                ) : (
                  <>
                    <CloudUpload className="w-4 h-4" />
                    {pushT("sendButton")}
                  </>
                )}
              </button>

              {/* Results */}
              {pushSendResult && (
                <div className={`rounded-lg border p-4 ${
                  pushSendResult.errors > 0 ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"
                }`}>
                  <div className="flex items-center gap-2 mb-2">
                    {pushSendResult.errors > 0 ? (
                      <AlertTriangle className="w-5 h-5 text-amber-600" />
                    ) : (
                      <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                    )}
                    <span className="font-medium text-sm">
                      {pushT("resultLabel")}: {pushSendResult.sent}/{pushSendResult.total} {pushT("sentWord")}
                      {pushSendResult.errors > 0 && (
                        <span className="text-amber-600"> — {pushSendResult.errors} {pushT("errorsWord")}</span>
                      )}
                    </span>
                  </div>
                  {pushSendResult.results.length > 0 && (
                    <details className="mt-2">
                      <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                        {pushT("showDetails")} ({pushSendResult.results.length})
                      </summary>
                      <ul className="mt-2 space-y-0.5 text-[11px] text-gray-600">
                        {pushSendResult.results.map((r: string, i: number) => (
                          <li key={i} className="font-mono break-all">{r}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </div>

            {/* Confirmation dialog */}
            {pushConfirmOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setPushConfirmOpen(false)}>
                <div className="bg-white rounded-xl shadow-2xl p-6 mx-4 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-start gap-3 mb-4">
                    <AlertTriangle className="w-6 h-6 text-amber-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <h3 className="text-base font-semibold text-gray-900">{pushT("confirmTitle")}</h3>
                      <p className="text-sm text-gray-600 mt-1">{pushT("confirmMessage")}</p>
                      <div className="mt-3 bg-gray-50 rounded-lg p-3 text-sm">
                        <p className="font-medium text-gray-700">{pushForm.title}</p>
                        <p className="text-gray-600 mt-0.5">{pushForm.body}</p>
                        {pushForm.url && <p className="text-blue-600 text-xs mt-1 truncate">{pushForm.url}</p>}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-3 justify-end">
                    <button
                      type="button"
                      onClick={() => setPushConfirmOpen(false)}
                      className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors text-sm"
                    >
                      {t.configManager?.buttons?.cancel || ct("messages.cancel", "取消", "Cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        setPushConfirmOpen(false);
                        setPushSendStatus("sending");
                        setPushSendResult(null);
                        try {
                          const bp = (workingConfig as any)?.backendProxyConfig;
                          const url = (bp?.supabaseUrl || "").trim().replace(/\/$/, "");
                          const anon = (bp?.supabaseAnonKey || "").trim();
                          const fn = (bp?.edgeFunctionName || "server").trim() || "server";
                          const base = `${url}/functions/v1/${fn}`;
                          const token = (() => {
                            try {
                              const raw = localStorage.getItem("sb-" + (bp?.supabaseUrl || "").split("//")[1]?.split(".")[0] + "-auth-token");
                              if (raw) {
                                const parsed = JSON.parse(raw);
                                return parsed?.access_token || "";
                              }
                            } catch { /* ignore */ }
                            return "";
                          })();
                          const res = await fetch(`${base}/push/send`, {
                            method: "POST",
                            headers: {
                              "Content-Type": "application/json",
                              Authorization: token ? `Bearer ${token}` : "",
                              apikey: anon,
                            },
                            body: JSON.stringify({
                              title: pushForm.title.trim(),
                              body: pushForm.body.trim(),
                              url: pushForm.url.trim() || "",
                            }),
                          });
                          const data = await res.json().catch(() => ({}));
                          setPushSendResult({
                            sent: data.sent ?? 0,
                            total: data.total ?? 0,
                            errors: data.errors ?? 0,
                            results: data.results || [],
                          });
                        } catch (e: any) {
                          setPushSendResult({
                            sent: 0,
                            total: 0,
                            errors: 1,
                            results: [e?.message || pushT("networkError")],
                          });
                        }
                        setPushSendStatus("done");
                        setTimeout(() => setPushSendStatus("idle"), 3000);
                      }}
                      className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm flex items-center gap-1.5"
                    >
                      <CloudUpload className="w-4 h-4" />
                      {pushT("confirmSendButton")}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : activeTab === "userRoles" ? (
          <div className="space-y-4">
            {isDeveloperMode() && contentRole !== "admin" && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-[11px] text-blue-900">
                {ct("messages.dev_mode_this_entry_is_visible_if_your", "开发者模式：此处入口已显示。若当前账号在数据库中不是 content_role=admin，调用列表/写入接口会返回 403，属预期。生产环境仅超级管理员可见此页。", "Dev mode: this entry is visible. If your DB content_role is not admin, list/write APIs return 403 — expected. In production, only content super-admins see this page.")}
              </div>
            )}
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-[11px] text-amber-900 space-y-1">
              <p>
                {ct("messages.writes_user_profiles_by_supabase_auth_user_uuid", "按 Supabase Auth 用户 UUID 写入 user_profiles：content_role 为 none 或 editor；app_role 为 farmer 或 distributor。此页不能授予 content admin。", "Writes user_profiles by Supabase Auth user UUID: content_role is none or editor; app_role is farmer or distributor. This page cannot grant content admin.")}
              </p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-800">{ct("messages.distributor_list", "分销商列表", "Distributor list")}</h3>
              <p className="text-xs text-gray-500">
                {ct("messages.exports_distributors_max_5000_row_1_headers_with", "导出当前 app_role 为 distributor 的用户（最多 5000 条）。CSV 第 1 行为带说明的表头，第 2 行为填写规则；改角色时请填英文 none / editor / farmer / distributor，勿用对勾。", "Exports distributors (max 5000). Row 1: headers with hints; row 2: how to fill. Use lowercase English for roles — no checkmarks.")}
              </p>
              <button
                type="button"
                disabled={roleApplyBusy}
                onClick={() => void downloadDistributorsCsv()}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-50"
              >
                {roleApplyBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {ct("messages.download_csv", "下载 CSV", "Download CSV")}
              </button>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-800">{ct("messages.excel_bulk_import", "批量导入 Excel", "Excel bulk import")}</h3>
              <p className="text-xs text-gray-500">
                {ct("messages.headers_must_resolve_to_user_id_content_role", "表头须能识别 user_id、content_role、app_role（可与下载文件一样带中文说明）。单元格请填英文小写：none、editor、farmer、distributor；不要用 √。留空表示该项不修改。每次最多 200 行，超出自动分批。", "Headers must resolve to user_id, content_role, app_role (Chinese hints OK). Values: lowercase none, editor, farmer, distributor — no checkmarks. Blank = skip field. Batches of 200.")}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={downloadRoleImportTemplate}
                  className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  {ct("messages.download_template", "下载导入模板", "Download template")}
                </button>
                <button
                  type="button"
                  disabled={roleApplyBusy}
                  onClick={() => roleExcelInputRef.current?.click()}
                  className="px-3 py-2 text-sm bg-gray-800 text-white rounded-lg hover:bg-gray-900 disabled:opacity-50"
                >
                  {ct("messages.upload_excel", "上传 Excel", "Upload Excel")}
                </button>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-800">{ct("messages.single_user", "单个用户", "Single user")}</h3>
              <input
                type="text"
                value={roleSingleUserId}
                onChange={(e) => setRoleSingleUserId(e.target.value)}
                placeholder={ct("messages.user_uuid", "用户 UUID", "User UUID")}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-xs"
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">content_role</label>
                  <select
                    value={roleSingleContent}
                    onChange={(e) => setRoleSingleContent(e.target.value as "" | "none" | "editor")}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                  >
                    <option value="">{ct("messages.leave_unchanged", "不修改", "Leave unchanged")}</option>
                    <option value="none">none</option>
                    <option value="editor">editor</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">app_role</label>
                  <select
                    value={roleSingleApp}
                    onChange={(e) => setRoleSingleApp(e.target.value as "" | "farmer" | "distributor")}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                  >
                    <option value="">{ct("messages.leave_unchanged", "不修改", "Leave unchanged")}</option>
                    <option value="farmer">farmer</option>
                    <option value="distributor">distributor</option>
                  </select>
                </div>
              </div>
              <button
                type="button"
                disabled={roleApplyBusy}
                onClick={() => void applySingleUserRole()}
                className="w-full py-2.5 bg-emerald-600 text-white rounded-lg text-sm hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {roleApplyBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {ct("messages.apply", "应用", "Apply")}
              </button>
            </div>
            {roleBulkResult ? (
              <pre className="text-[11px] bg-gray-50 border border-gray-200 rounded-lg p-3 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                {roleBulkResult}
              </pre>
            ) : null}
          </div>
        ) : activeTab === "chatContact" ? (
          <>
            <div className="mb-4 p-4 rounded-xl border-2 border-amber-200 bg-amber-50/95 shadow-sm">
              <p className="text-sm font-semibold text-amber-900 mb-1">{ct("messages.scan_to_bind_domain_whitelist", "扫码绑定 · 域名校验白名单", "Scan-to-bind · domain whitelist")}</p>
              <p className="text-[11px] text-amber-800/90 mb-3 leading-relaxed">{ct("messages.when_a_farmer_scans_a_merchant_qr_in", "农户在「圈子」中扫一扫添加商家时，二维码内链接的域名必须在此列表中，否则将拒绝绑定。可填根域名，子域也会匹配。留空时客户端将拒绝所有扫码。", "When a farmer scans a merchant QR in Community, the URL hostname must match an entry here. Root domains allow subdomains. If empty, the app rejects all merchant-bind scans.")}</p>
              {(workingConfig.chatContact?.verifiedDomains || []).map((domain: string, idx: number) => (
                <div key={idx} className="flex items-center gap-2 mb-2">
                  <input
                    type="text"
                    value={domain}
                    onChange={(e) => {
                      const list = [...(workingConfig.chatContact?.verifiedDomains || [])];
                      list[idx] = e.target.value;
                      patchChatContactDomains(list);
                    }}
                    placeholder="example.com"
                    className="flex-1 px-3 py-2.5 border border-amber-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400 text-sm font-mono bg-white"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const list = (workingConfig.chatContact?.verifiedDomains || []).filter(
                        (_: string, i: number) => i !== idx,
                      );
                      patchChatContactDomains(list);
                    }}
                    className="p-2 text-red-600 hover:bg-red-100 rounded-lg transition-colors shrink-0"
                    aria-label={ct("messages.remove_domain", "移除此域名", "Remove domain")}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  const list = [...(workingConfig.chatContact?.verifiedDomains || []), ""];
                  patchChatContactDomains(list);
                }}
                className="w-full px-3 py-2.5 bg-amber-100/90 text-amber-900 border-2 border-dashed border-amber-300 rounded-lg hover:bg-amber-200/90 transition-colors flex items-center justify-center gap-2 text-xs font-medium"
              >
                <Plus className="w-3.5 h-3.5" />
                {ct("messages.add_allowed_domain", "添加允许域名", "Add allowed domain")}
              </button>
            </div>
            <div className="mb-4 p-4 rounded-xl border border-violet-200 bg-violet-50/80">
              <p className="text-sm font-medium text-gray-800 mb-2">{ct("messages.community_tab_ui_mode", "聊天 Tab 界面模式", "Community tab UI mode")}</p>
              <p className="text-[11px] text-amber-900/90 mb-2 rounded-lg bg-amber-50 border border-amber-100 px-2 py-1.5">{ct("messages.signed_in_users_community_and_profile_use_db", "已登录用户：社区与个人中心的「农户 / 门店」界面由数据库 user_profiles.app_role（farmer / distributor）决定，不受此处开关影响。请在 Supabase SQL 或 Dashboard 修改 app_role。此处仅作未拿到角色或 Edge 失败时的回退，以及离线默认。", "Signed-in users: Community and Profile use DB column user_profiles.app_role (farmer / distributor), not this toggle. Set app_role in Supabase SQL or Dashboard. This switch is only a fallback when the role is unavailable or Edge fails, plus offline defaults.")}</p>
              <p className="text-[11px] text-gray-600 mb-3">{ct("messages.farmer_single_contact_full_page_chat_default_store", "农户：单联系人整页聊天（默认）。门店：最近会话 + 通讯录 + 多会话，数据在门店设备本地积累。", "Farmer: single-contact full-page chat (default). Store: recents + contacts + multiple threads; data accumulates on the store device.")}</p>
              <div className="flex flex-wrap gap-2">
                {([
                  { key: "farmer" as const, label: ct("messages.farmer_1_1", "农户（一对一）", "Farmer (1:1)") },
                  { key: "store" as const, label: ct("messages.store_multi", "门店（一对多）", "Store (multi)") },
                ]).map((opt) => {
                  const cur = workingConfig.communityUiMode === "store" ? "store" : "farmer";
                  const active = cur === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => {
                        const newConfig = JSON.parse(JSON.stringify(workingConfig));
                        newConfig.communityUiMode = opt.key;
                        setWorkingConfig(newConfig);
                        setHasChanges(true);
                      }}
                      className={`px-4 py-2 rounded-lg text-sm border-2 transition-colors ${
                        active ? "border-emerald-500 bg-emerald-50 text-emerald-800" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
            {renderTable()}
          </>
        ) : (
          <>
            {/* 卡片网格 */}
            {renderTable()}
          </>
        )}
      </div>
      )}
      </div>{/* 关闭可滚动内容区域 */}
      </div>{/* 关闭侧边栏+内容flex容器 */}

      {/* 编辑对话框 */}
      {renderEditDialog()}

    </div>
  );
}



// 输入框组件
function InputField({ label, value, onChange, disabled = false, placeholder = "", type = "text" }: any) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type}
        value={value || ""}
        onChange={(e) => onChange?.(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 disabled:bg-gray-100"
      />
    </div>
  );
}

// 下拉框组件
function SelectField({ label, value, onChange, options }: any) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select
        value={value || ""}
        onChange={(e) => onChange?.(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
      >
        {options.map((option: string) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </div>
  );
}

// 文本域组件
function TextAreaField({ label, value, onChange, rows = 6, placeholder = "" }: any) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <textarea
        value={value || ""}
        onChange={(e) => onChange?.(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
      />
    </div>
  );
}
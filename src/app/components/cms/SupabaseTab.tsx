import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Cloud, CloudOff, Loader2, Shield } from "lucide-react";
import { useConfigContext } from "../../hooks/ConfigProvider";
import type { BackendProxyConfig, CmsStorageProvider } from "../../hooks/useHomeConfig";
import {
  testConnection as supabaseTestConnection,
  isSupabaseConfigured,
  type TestConnectionResult,
} from "../../services/ConfigSyncService";
import { emptyBackendProxyShell, type CmsTabProps } from "./cmsTab";

type LinkedTab = "backendProxy" | "aiModel" | "pushProviders" | "loginConfig";

export function SupabaseTab({
  workingConfig,
  patchSection,
  ct,
  onOpenTab,
}: CmsTabProps & { onOpenTab: (tab: LinkedTab) => void }) {
  const { syncStatus, remoteVersion, lastSyncTime, lastSyncError } = useConfigContext();
  const patchBackend = (p: Partial<BackendProxyConfig>) =>
    patchSection("backendProxyConfig", workingConfig.backendProxyConfig ? p : { ...emptyBackendProxyShell(), ...p });

  const [supabaseTestLoading, setSupabaseTestLoading] = useState(false);
  const [supabaseTestMessage, setSupabaseTestMessage] = useState<{
    kind: "ok" | "warn" | "err";
    text: string;
  } | null>(null);
  const supabaseTestMessageRef = useRef<HTMLParagraphElement>(null);

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

  useEffect(() => {
    if ((supabaseTestMessage || supabaseTestLoading) && supabaseTestMessageRef.current) {
      supabaseTestMessageRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [supabaseTestMessage, supabaseTestLoading]);

  return (
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
              patchBackend({ supabaseUrl: e.target.value });
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
              patchBackend({ supabaseAnonKey: e.target.value });
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
              patchBackend({ cmsStorageProvider: v });
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
              patchBackend({ mediaCdnBaseUrl: e.target.value });
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
              onClick={() => onOpenTab(mod.tab)}
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
  );
}

export default SupabaseTab;

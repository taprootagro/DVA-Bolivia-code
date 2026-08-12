import { useNavigate } from "react-router";
import { Suspense, lazy } from "react";
import { ArrowLeft, Loader2, ShieldAlert } from "lucide-react";
import { useContentSuperAdmin } from "../hooks/useContentSuperAdmin";
import { useLanguage } from "../hooks/useLanguage";
import { createCmsTranslator } from "../i18n/cmsTranslate";
import enTranslations from "../i18n/lang/en";
import { isUserLoggedIn, isServerAssignedId } from "../utils/auth";
import { isDeveloperMode } from "../utils/developerMode";
import { SkeletonScreen } from "./SkeletonScreen";

const ConfigManagerPageLazy = lazy(() => import("./ConfigManagerPage"));

/**
 * Loads ConfigManager chunk only after Supabase session + contentSuperAdmin.
 */
export function ConfigManagerGate() {
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const { contentSuperAdmin, contentRole, loading, error } = useContentSuperAdmin();

  const ct = createCmsTranslator(t, language, enTranslations);

  const allowed =
    isDeveloperMode() ||
    (!loading &&
      isUserLoggedIn() &&
      isServerAssignedId() &&
      (contentRole === 'admin' || contentRole === 'editor'));

  if (allowed) {
    return (
      <Suspense fallback={<SkeletonScreen />}>
        <ConfigManagerPageLazy />
      </Suspense>
    );
  }

  return (
    <div
      className="fixed inset-0 flex flex-col overflow-hidden bg-gray-50"
      style={{
        height: "var(--app-height, 100dvh)",
      }}
    >
      <div className="bg-emerald-600 safe-top flex-shrink-0" />
      <div className="bg-emerald-600 text-white px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <button
          type="button"
          onClick={() =>
            navigate("/home/settings", { state: { settingsFrom: "/home/profile" } })
          }
          className="p-1.5 hover:bg-emerald-700 rounded-lg transition-colors flex-shrink-0"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="font-semibold text-base sm:text-lg truncate">
          {ct("messages.content_manager", "内容管理器", "Content Manager")}
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-gray-600">
            <Loader2 className="w-8 h-8 animate-spin text-emerald-600" />
            <p className="text-sm">{ct("messages.checking_permissions", "正在验证权限…", "Checking permissions…")}</p>
          </div>
        )}

        {!loading && error && (
          <div className="p-6 text-center text-red-600 text-sm">{error}</div>
        )}

        {!loading && !isUserLoggedIn() && (
          <div className="p-8 max-w-md mx-auto text-center space-y-4">
            <ShieldAlert className="w-12 h-12 text-amber-500 mx-auto" />
            <p className="text-gray-700">
              {ct("messages.please_sign_in_with_your_supabase_backed_account", "请先使用 Supabase 账号登录。", "Please sign in with your Supabase-backed account first.")}
            </p>
            <button
              type="button"
              onClick={() => navigate("/login")}
              className="px-6 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700"
            >
              {t.common.login}
            </button>
          </div>
        )}

        {!loading && isUserLoggedIn() && !isServerAssignedId() && (
          <div className="p-8 max-w-md mx-auto text-center space-y-4">
            <ShieldAlert className="w-12 h-12 text-amber-500 mx-auto" />
            <p className="text-gray-700 text-sm">
              {ct("messages.this_session_is_offline_demo_mode_use_phone", "当前为离线演示账号，无法使用云端内容管理。请使用手机号/邮箱或社交登录绑定 Supabase。", "This session is offline demo mode. Use phone, email, or social login linked to Supabase.")}
            </p>
          </div>
        )}

        {!loading && isUserLoggedIn() && isServerAssignedId() && !(contentRole === 'admin' || contentRole === 'editor') && (
          <div className="p-8 max-w-md mx-auto text-center space-y-4">
            <ShieldAlert className="w-12 h-12 text-gray-400 mx-auto" />
            <p className="text-gray-700">
              {ct("messages.access_denied_content_admins_editors_only", "无权限：仅内容管理员可访问此页。", "Access denied: content admins/editors only.")}
            </p>
            <p className="text-xs text-gray-500">
              {ct("messages.ask_your_operator_to_set_content_role_admin", "请在数据库中为您的 user_id 设置 content_role = 'admin' 或 'editor'（见部署文档）。", "Ask your operator to set content_role = 'admin' or 'editor' for your user_id (see deploy docs).")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

import { Shield } from "lucide-react";
import type { HomePageConfig } from "../../hooks/useHomeConfig";
import type { CmsTabProps } from "./cmsTab";

/** Loose view: the UI also toggles `line`, which LoginConfig's types don't list. */
type LoginView = {
  socialProviders?: Record<string, boolean | undefined>;
  oauthCredentials?: Record<string, Record<string, string> | undefined>;
  enablePhoneLogin?: boolean;
  enableEmailLogin?: boolean;
  defaultLoginMethod?: "phone" | "email";
};

const DEFAULT_LOGIN_CONFIG: LoginView = {
  socialProviders: { wechat: true, google: true, facebook: true, apple: true, alipay: true, line: true, twitter: true },
  oauthCredentials: {},
  enablePhoneLogin: true,
  enableEmailLogin: true,
  defaultLoginMethod: "phone",
};

export function LoginConfigTab({ workingConfig, patchSection, ct }: CmsTabProps) {
  const login = (workingConfig.loginConfig ?? DEFAULT_LOGIN_CONFIG) as LoginView;
  const patchLogin = (p: LoginView) =>
    patchSection(
      "loginConfig",
      (workingConfig.loginConfig ? p : { ...DEFAULT_LOGIN_CONFIG, ...p }) as unknown as Partial<HomePageConfig["loginConfig"]>,
    );

  return (
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
            const isEnabled = login.socialProviders?.[provider.key] !== false;

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
                      patchLogin({ socialProviders: { ...login.socialProviders, [provider.key]: !isEnabled } });
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
        {(['wechat', 'alipay', 'line'] as const).filter(k => login.socialProviders?.[k] !== false).map(k => {
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
              value={(login.oauthCredentials?.[k] as any)?.[fieldKey] || ''}
              onChange={(e) => {
                const creds = login.oauthCredentials ?? {};
                patchLogin({ oauthCredentials: { ...creds, [k]: { ...(creds[k] ?? (isLine ? { channelId: '' } : { appId: '' })), [fieldKey]: e.target.value } } });
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
                const enablePhoneLogin = login.enablePhoneLogin === false;
                patchLogin({
                  enablePhoneLogin,
                  ...(!enablePhoneLogin && login.defaultLoginMethod === 'phone' ? { defaultLoginMethod: 'email' as const } : {}),
                });
              }}
              className={`relative w-12 h-6 rounded-full transition-colors ${
                login.enablePhoneLogin !== false ? "bg-emerald-500" : "bg-gray-300"
              }`}
            >
              <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                login.enablePhoneLogin !== false ? "translate-x-6" : "translate-x-0.5"
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
                const enableEmailLogin = login.enableEmailLogin === false;
                patchLogin({
                  enableEmailLogin,
                  ...(!enableEmailLogin && login.defaultLoginMethod === 'email' ? { defaultLoginMethod: 'phone' as const } : {}),
                });
              }}
              className={`relative w-12 h-6 rounded-full transition-colors ${
                login.enableEmailLogin !== false ? "bg-emerald-500" : "bg-gray-300"
              }`}
            >
              <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                login.enableEmailLogin !== false ? "translate-x-6" : "translate-x-0.5"
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
                    patchLogin({ defaultLoginMethod: method.key });
                  }}
                  className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                    (login.defaultLoginMethod || 'phone') === method.key
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
                .filter(k => login.socialProviders?.[k] !== false)
                .map(k => ({ wechat: 'WeChat', google: 'Google', facebook: 'Facebook', apple: 'Apple', alipay: 'Alipay', line: 'LINE', twitter: 'X' }[k]))
                .join(', ') || ct("messages.none", "无", "None")}
            </p>
            <p>{ct("messages.account_login", "账号登录：", "Account Login: ")}
              {[
                login.enablePhoneLogin !== false ? ct("messages.phone", "手机号", "Phone") : null,
                login.enableEmailLogin !== false ? ct("messages.email", "邮箱", "Email") : null
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
  );
}

export default LoginConfigTab;

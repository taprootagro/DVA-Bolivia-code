import type { PushProvidersConfig } from "../../hooks/useHomeConfig";
import type { CmsTabProps } from "./cmsTab";

type ProviderKey = "webpush" | "fcm" | "onesignal" | "jpush" | "getui";

export function PushProvidersTab({ workingConfig, patchSection, ct }: CmsTabProps) {
  const pc = (workingConfig.pushProvidersConfig || {}) as Partial<PushProvidersConfig>;
  /** Missing provider block starts as { enabled: true }, as the old inline handlers did. */
  const patchProvider = (key: ProviderKey, fields: Record<string, unknown>) =>
    patchSection("pushProvidersConfig", {
      [key]: { ...(pc[key] ?? { enabled: true }), ...fields },
    } as Partial<PushProvidersConfig>);
  const activateProvider = (key: ProviderKey) =>
    patchSection("pushProvidersConfig", {
      activeProvider: key,
      [key]: { ...pc[key], enabled: true },
    } as Partial<PushProvidersConfig>);

  return (
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
            const isActive = (pc.activeProvider || 'webpush') === provider.key;
            const providerConfig: { enabled?: boolean } = pc[provider.key] || {};
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
                      activateProvider(provider.key);
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
                              patchProvider("webpush", { vapidPublicKey: e.target.value });
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
                              patchProvider("webpush", { pushApiBase: e.target.value });
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
                                patchProvider("fcm", { [field]: e.target.value });
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
                              patchProvider("onesignal", { appId: e.target.value });
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
                              patchProvider("onesignal", { safariWebId: e.target.value });
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
                              patchProvider("jpush", { appKey: e.target.value });
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
                              patchProvider("jpush", { channel: e.target.value });
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
                              patchProvider("jpush", { pushApiBase: e.target.value });
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
                              patchProvider("getui", { appId: e.target.value });
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
                              patchProvider("getui", { appKey: e.target.value });
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
                              patchProvider("getui", { pushApiBase: e.target.value });
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
  );
}

export default PushProvidersTab;

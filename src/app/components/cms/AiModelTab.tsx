import { useState } from "react";
import type { AIModelConfig, CloudAIConfig } from "../../hooks/useHomeConfig";
import { ensureEdgeSessionReady } from "../../utils/auth";
import { pickCloudAISupabase } from "../../services/CloudAIService";
import type { CmsTabProps } from "./cmsTab";

/** Empty input → undefined (built-in default); otherwise clamped integer — same rules the old inline handlers used. */
function optionalInt(raw: string, min: number, max: number): number | undefined {
  return raw === "" ? undefined : Math.min(max, Math.max(min, parseInt(raw, 10) || 0));
}

type HealthState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; provider: string; modelId: string; configured: boolean }
  | { kind: "error"; message: string };

export function AiModelTab({ workingConfig, patchSection, ct }: CmsTabProps) {
  const ai = workingConfig.aiModelConfig;
  const cloud = workingConfig.cloudAIConfig;
  const patchAiModel = (p: Partial<AIModelConfig>) => patchSection("aiModelConfig", p);
  const patchCloudAI = (p: Partial<CloudAIConfig>) => patchSection("cloudAIConfig", p);
  const backendCredsActive = pickCloudAISupabase(cloud, workingConfig.backendProxyConfig).usesBackend;

  const [health, setHealth] = useState<HealthState>({ kind: "idle" });

  const testHealth = async () => {
    const { url, anon } = pickCloudAISupabase(cloud, workingConfig.backendProxyConfig);
    if (!url || !anon) {
      setHealth({ kind: "error", message: ct("messages.ai_health_missing_supabase", "未配置 Supabase URL / Anon Key", "Supabase URL / anon key not configured") });
      return;
    }
    setHealth({ kind: "loading" });
    const token = await ensureEdgeSessionReady();
    if (!token) {
      setHealth({ kind: "error", message: ct("messages.ai_health_login_required", "需要先登录（网关校验 JWT）", "Sign in first (the gateway verifies the JWT)") });
      return;
    }
    const fn = (cloud?.edgeFunctionName || "ai-vision-proxy").replace(/^\/+/, "");
    try {
      const res = await fetch(`${url}/functions/v1/${fn}/health`, {
        headers: { Authorization: `Bearer ${token}`, apikey: anon },
      });
      const body = (await res.json().catch(() => null)) as {
        provider?: unknown;
        modelId?: unknown;
        configured?: unknown;
        error?: unknown;
        message?: unknown;
      } | null;
      if (!res.ok || typeof body?.provider !== "string") {
        const detail = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "";
        setHealth({ kind: "error", message: `HTTP ${res.status}${detail ? ` — ${detail}` : ""}` });
        return;
      }
      setHealth({ kind: "ok", provider: body.provider, modelId: String(body.modelId ?? ""), configured: body.configured === true });
    } catch (e) {
      setHealth({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-4">
        <h3 className="text-base text-gray-800 mb-2">{ct("messages.ai_pest_disease_detection_model_config", "AI 病虫害识别模型配置", "AI Pest & Disease Detection Model Config")}</h3>
        <p className="text-xs text-gray-500 -mt-2">{ct("messages.online_deep_analysis_uses_third_party_cloud_llms", "在线深度分析依赖第三方云端大模型（经 Supabase Edge 代理）。本地 ONNX 与在线 AI 可分别开关；默认仅开启在线。关闭在线后不会请求云端；关闭本地后断网不再回退端侧推理。", "Online deep analysis uses third-party cloud LLMs (via Supabase Edge). Local ONNX and online AI can be toggled independently; default is online only. When online AI is off, no cloud requests are made. When local is off, the app does not fall back to on-device inference offline.")}</p>

        {/* Mode indicator */}
        <div className="flex items-center gap-2 bg-gray-50 rounded-lg p-3">
          <div className={`w-2 h-2 rounded-full ${
            (() => {
              const cOn = cloud?.enabled === true;
              const lOn = ai?.enableLocalModel === true;
              if (!cOn && !lOn) return "bg-red-400";
              if (cOn && lOn) return "bg-emerald-500";
              return cOn ? "bg-violet-500" : "bg-amber-500";
            })()
          }`} />
          <span className="text-xs text-gray-600">
            {(() => {
              const cOn = cloud?.enabled === true;
              const lOn = ai?.enableLocalModel === true;
              const hasUrl = !!(ai?.modelUrl && ai.modelUrl.startsWith("http"));
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
            onClick={() => patchAiModel({ enableLocalModel: !(ai?.enableLocalModel ?? false) })}
            className={`relative w-12 h-6 rounded-full transition-colors ${
              ai?.enableLocalModel ? "bg-emerald-500" : "bg-gray-300"
            }`}
          >
            <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
              ai?.enableLocalModel ? "translate-x-6" : "translate-x-0.5"
            }`} />
          </button>
        </div>

        {/* Model URL */}
        <div>
          <label className="block text-sm text-gray-700 mb-1">{ct("messages.onnx_model_file_url", "ONNX 模型文件 URL", "ONNX Model File URL")}</label>
          <input
            type="text"
            value={ai?.modelUrl || ""}
            onChange={(e) => patchAiModel({ modelUrl: e.target.value })}
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
            value={ai?.labelsUrl || ""}
            onChange={(e) => patchAiModel({ labelsUrl: e.target.value })}
            placeholder="https://cdn.example.com/models/labels.json"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
          />
          <p className="mt-1 text-[11px] text-gray-400">{ct("messages.json_array_format_e_g_rice_blast_powdery", "JSON 数组格式，例如：[\"稻瘟病\",\"白粉病\",\"蚜虫\",...]", "JSON array format, e.g.: [\"Rice Blast\",\"Powdery Mildew\",\"Aphids\",...]")}</p>
        </div>

        {/* Status indicator */}
        <div className="pt-3 border-t border-gray-100">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${
              (ai?.modelUrl && ai.modelUrl.startsWith("http"))
                ? "bg-emerald-500"
                : "bg-gray-300"
            }`} />
            <span className="text-xs text-gray-600">
              {(ai?.modelUrl && ai.modelUrl.startsWith("http"))
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
            onClick={() => patchCloudAI({ enabled: !(cloud?.enabled ?? false) })}
            className={`relative w-12 h-6 rounded-full transition-colors ${
              cloud?.enabled ? "bg-emerald-500" : "bg-gray-300"
            }`}
          >
            <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
              cloud?.enabled ? "translate-x-6" : "translate-x-0.5"
            }`} />
          </button>
        </div>

        {/* Supabase for cloud AI only — independent of IM toggle */}
        <div className="space-y-3 pt-1 border-t border-gray-100">
          <p className="text-xs text-gray-600">{ct("messages.supabase_for_cloud_vision_only_independent_of_im", "云端识图专用 Supabase（与「启用 IM 直连」无关）。若填写则优先使用；若留空则回退使用 IM 后端代理页中的项目地址（无需开启 IM）。", "Supabase for cloud vision only (independent of IM). If set, used first; if empty, falls back to the Backend Proxy tab URL/key (IM toggle not required).")}</p>
          {backendCredsActive && (
            <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              {ct("messages.cloud_ai_uses_backend_proxy_credentials", "使用后端代理凭证：已启用后端代理，云端识图固定使用「后端代理」页的 Supabase URL / Anon Key（保证用户 JWT 与 Edge 同项目），下方两项不生效。", "Using backend proxy credentials: the backend proxy is enabled, so cloud AI always uses the Backend Proxy tab's Supabase URL / anon key (keeps the user JWT on the Edge's project); the two fields below are ignored.")}
            </p>
          )}
          <div className={backendCredsActive ? "opacity-60" : undefined}>
            <label className="block text-sm text-gray-700 mb-1">{ct("messages.supabase_project_url_cloud_ai", "Supabase 项目 URL（云端识图）", "Supabase project URL (cloud AI)")}</label>
            <input
              type="text"
              disabled={backendCredsActive}
              value={cloud?.supabaseUrl || ""}
              onChange={(e) => patchCloudAI({ supabaseUrl: e.target.value })}
              placeholder="https://xxxx.supabase.co"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs disabled:bg-gray-50"
            />
          </div>
          <div className={backendCredsActive ? "opacity-60" : undefined}>
            <label className="block text-sm text-gray-700 mb-1">{ct("messages.supabase_anon_key_cloud_ai", "Supabase Anon Key（云端识图）", "Supabase anon key (cloud AI)")}</label>
            <input
              type="password"
              autoComplete="off"
              disabled={backendCredsActive}
              value={cloud?.supabaseAnonKey || ""}
              onChange={(e) => patchCloudAI({ supabaseAnonKey: e.target.value })}
              placeholder={ct("messages.project_settings_api_anon_public", "项目 Settings → API → anon public", "Project Settings → API → anon public")}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs disabled:bg-gray-50"
            />
          </div>
        </div>

        {/* Provider Name */}
        <div>
          <label className="block text-sm text-gray-700 mb-1">{ct("messages.provider_display_name", "模型提供商显示名称", "Provider Display Name")}</label>
          <input
            type="text"
            value={cloud?.providerName || ""}
            onChange={(e) => patchCloudAI({ providerName: e.target.value })}
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
            value={cloud?.edgeFunctionName || "ai-vision-proxy"}
            onChange={(e) => patchCloudAI({ edgeFunctionName: e.target.value })}
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
            value={cloud?.modelId || ""}
            onChange={(e) => patchCloudAI({ modelId: e.target.value })}
            placeholder={ct("messages.e_g_qwen_vl_plus_gemini_2_0", "例如：qwen-vl-plus, gemini-2.0-flash, gpt-4o", "e.g. qwen-vl-plus, gemini-2.0-flash, gpt-4o")}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
          />
          <p className="mt-1 text-[11px] text-gray-400">{ct("messages.model_id_read_by_edge_from_app_config", "推送到云端后由 Edge 从 app_config 读取（Secret AI_MODEL_ID 优先；设置了 AI_MODEL_ALLOWLIST 时须在白名单内）。须与 Secret AI_PROVIDER 选定的提供商匹配。", "After you push, the Edge reads this from app_config (the AI_MODEL_ID secret wins; must be in AI_MODEL_ALLOWLIST if one is set). Must belong to the provider chosen by the AI_PROVIDER secret.")}</p>
        </div>

        {/* System Prompt */}
        <div>
          <label className="block text-sm text-gray-700 mb-1">{ct("messages.system_prompt", "系统提示词 (System Prompt)", "System Prompt")}</label>
          <textarea
            value={cloud?.systemPrompt || ""}
            onChange={(e) => patchCloudAI({ systemPrompt: e.target.value })}
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
            value={cloud?.maxTokens || 512}
            onChange={(e) => patchCloudAI({ maxTokens: parseInt(e.target.value) || 512 })}
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
              value={cloud?.clientDailyLimit ?? ""}
              placeholder="15"
              onChange={(e) => patchCloudAI({ clientDailyLimit: optionalInt(e.target.value, 1, 999) })}
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
              value={cloud?.clientCooldownSeconds ?? ""}
              placeholder="20"
              onChange={(e) => patchCloudAI({ clientCooldownSeconds: optionalInt(e.target.value, 0, 3600) })}
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
              value={cloud?.clientWindowPerMin ?? ""}
              placeholder="6"
              onChange={(e) => patchCloudAI({ clientWindowPerMin: optionalInt(e.target.value, 1, 200) })}
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
              value={cloud?.clientMaxConcurrent ?? ""}
              placeholder="100"
              onChange={(e) => patchCloudAI({ clientMaxConcurrent: optionalInt(e.target.value, 5, 100) })}
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
              value={cloud?.clientChatMinIntervalSeconds ?? ""}
              placeholder={ct("messages.same_as_min_interval", "同调用间隔", "Same as min interval")}
              onChange={(e) => patchCloudAI({ clientChatMinIntervalSeconds: optionalInt(e.target.value, 0, 3600) })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <p className="mt-1 text-[11px] text-gray-400">{ct("messages.client_follow_up_spacing_only_empty_same_as", "仅前端追问连发；留空与「调用间隔」相同", "Client follow-up spacing only; empty → same as min interval")}</p>
          </div>
          <div>
            <label className="block text-sm text-gray-700 mb-1">{ct("messages.client_max_image_size_px", "上传图片最长边（像素）", "Upload image max edge (px)")}</label>
            <input
              type="number"
              min={320}
              max={4096}
              value={cloud?.clientMaxImageSize ?? ""}
              placeholder="1024"
              onChange={(e) => {
                const raw = e.target.value;
                patchCloudAI({ clientMaxImageSize: raw === "" ? undefined : Math.min(4096, parseInt(raw, 10) || 0) || undefined });
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <p className="mt-1 text-[11px] text-gray-400">{ct("messages.client_max_image_size_hint", "320–4096；小于 320 视为无效。留空使用内置默认（1024）", "320–4096; values below 320 are ignored. Leave empty for the built-in default (1024)")}</p>
          </div>
          <div>
            <label className="block text-sm text-gray-700 mb-1">{ct("messages.client_image_quality", "图片压缩质量", "Image compression quality")}</label>
            <input
              type="number"
              min={0.1}
              max={1}
              step={0.05}
              value={cloud?.clientImageQuality ?? ""}
              placeholder="0.75"
              onChange={(e) => {
                const raw = e.target.value;
                const n = Number(raw);
                patchCloudAI({ clientImageQuality: raw === "" || !Number.isFinite(n) ? undefined : Math.min(1, n) });
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <p className="mt-1 text-[11px] text-gray-400">{ct("messages.client_image_quality_hint", "0–1 之间（不含 0）。留空使用内置默认（0.75）", "Between 0 and 1 (exclusive of 0). Leave empty for the built-in default (0.75)")}</p>
          </div>
        </div>

        {/* Status indicator */}
        <div className="pt-3 border-t border-gray-100">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${
              cloud?.enabled
                ? "bg-violet-500"
                : "bg-gray-300"
            }`} />
            <span className="text-xs text-gray-600">
              {cloud?.enabled
                ? `${ct("messages.cloud_ai_status_enabled", "已启用", "Enabled")} — ${cloud?.providerName || "Cloud AI"} (${cloud?.modelId || ct("messages.cloud_ai_model_not_set", "未设置", "not set")})`
                : ct("messages.disabled_no_cloud_requests_no_mock_demo", "未启用（不请求云端，无 Mock 演示）", "Disabled (no cloud requests, no mock demo)")
              }
            </span>
          </div>
        </div>

        {/* Edge health probe */}
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => void testHealth()}
              disabled={health.kind === "loading"}
              className="px-3 py-1.5 rounded-lg bg-violet-600 text-white text-xs active:scale-95 transition-transform disabled:opacity-50"
            >
              {health.kind === "loading"
                ? ct("messages.ai_health_testing", "测试中…", "Testing…")
                : ct("messages.test_ai_vision_proxy", "测试 ai-vision-proxy", "Test ai-vision-proxy")}
            </button>
            {health.kind === "ok" && (
              <span className={`text-xs font-mono ${health.configured ? "text-emerald-700" : "text-amber-700"}`}>
                provider={health.provider} · modelId={health.modelId || "—"} ·{" "}
                {health.configured
                  ? ct("messages.ai_health_key_configured", "密钥已配置", "API key configured")
                  : ct("messages.ai_health_key_missing", "密钥未配置（Edge Secret 缺失）", "API key missing (Edge secret not set)")}
              </span>
            )}
            {health.kind === "error" && <span className="text-xs text-red-600">{health.message}</span>}
          </div>
          <p className="text-[11px] text-gray-400">{ct("messages.ai_health_hint", "显示 Edge 实际生效的提供商与模型（读取已推送的 app_config，约 1 分钟缓存；不含本页未保存的修改）", "Shows the provider and model the Edge actually uses (from the pushed app_config, cached ~1 min; unsaved edits on this page are not included)")}</p>
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
            <li>{ct("messages.cloud_ai_config_holds_no_provider_secrets", "此处不保存任何模型 API 密钥；本页配置（模型标识、提示词、Max Tokens、限流等）推送后写入公开的 app_config，Supabase Anon Key 本身也是可公开的", "No provider API keys are stored here. These settings (model ID, prompt, max tokens, limits, …) are pushed to the public app_config; the Supabase anon key is publishable too")}</li>
            <li>{ct("messages.enter_supabase_url_anon_key_above_for_cloud", "在上方填写云端识图专用 Supabase URL/Anon Key，或在 IM 后端代理页填写并留空此处（会回退使用，无需开启 IM）", "Enter Supabase URL/anon key above for cloud AI, or only under Backend Proxy and leave these empty (fallback; IM toggle not required)")}</li>
          </ul>
        </div>

        {/* Edge Function Template */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mt-3">
          <p className="text-xs text-blue-800 mb-2">{ct("messages.edge_function_deployment_reference", "Edge Function 部署参考：", "Edge Function Deployment Reference:")}</p>
          <ol className="text-[11px] text-blue-700 space-y-1 list-decimal list-inside">
            <li>{ct("messages.create_supabase_functions_ai_vision_proxy_index_ts", "创建 supabase/functions/ai-vision-proxy/index.ts", "Create supabase/functions/ai-vision-proxy/index.ts")}</li>
            <li>{ct("messages.read_secrets_via_deno_env_get_qwen_api", "在 Edge Function 中读取 Deno.env.get('QWEN_API_KEY') 等密钥", "Read secrets via Deno.env.get('QWEN_API_KEY') in the Edge Function")}</li>
            <li>{ct("messages.edge_receives_image_reads_model_from_app_config", "接收前端传来的 { image, detections, uiLanguage }；modelId / systemPrompt / maxTokens 由 Edge 从 app_config 读取", "Receive { image, detections, uiLanguage } from the frontend; modelId / systemPrompt / maxTokens are read by the Edge from app_config")}</li>
            <li>{ct("messages.edge_routes_by_ai_provider_secret", "按 Secret AI_PROVIDER（qwen / gemini / openai）调用对应云 API；modelId 只决定该提供商下的模型", "Call the cloud API chosen by the AI_PROVIDER secret (qwen / gemini / openai); modelId only picks the model within that provider")}</li>
            <li>{ct("messages.return", "返回 { analysis: '...markdown text...', confidence: 0.92, suggestions: [...] }", "Return { analysis: '...markdown text...', confidence: 0.92, suggestions: [...] }")}</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

export default AiModelTab;

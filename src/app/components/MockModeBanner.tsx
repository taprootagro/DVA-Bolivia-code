import { AlertTriangle } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";

type MockModeBannerProps = {
  /** chat | ai | call */
  feature: "chat" | "ai" | "call";
};

const FEATURE_KEYS: Record<MockModeBannerProps["feature"], { zh: string; en: string }> = {
  chat: {
    zh: "聊天后端未配置，当前为演示模式，消息不会送达商户。请在配置管理中启用 Backend Proxy。",
    en: "Chat backend is not configured (demo mode). Messages will not reach the merchant. Enable Backend Proxy in Config Manager.",
  },
  ai: {
    zh: "云端 AI 未正确配置，无法提供真实分析。请检查 Supabase URL 与 Edge 函数。",
    en: "Cloud AI is not configured. Real analysis is unavailable. Check Supabase URL and Edge functions.",
  },
  call: {
    zh: "音视频通话尚未接入，当前不可用。",
    en: "Audio/video calls are not available yet.",
  },
};

/** Full-width warning when a feature runs in mock/demo mode in production builds. */
export function MockModeBanner({ feature }: MockModeBannerProps) {
  const { language } = useLanguage();
  const isZh = language === "zh" || language === "zh-TW";
  const copy = FEATURE_KEYS[feature];
  const message = isZh ? copy.zh : copy.en;

  return (
    <div
      role="alert"
      className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 border-b border-amber-200 text-amber-950 text-xs leading-snug shrink-0"
    >
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" aria-hidden />
      <p>{message}</p>
    </div>
  );
}

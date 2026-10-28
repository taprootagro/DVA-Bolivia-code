import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Language, Translations } from "./useLanguage";
import type { CloudAIConfig } from "./useHomeConfig";
import {
  cloudAIService,
  cloudAIUsesBackend,
  CLOUD_AI_SESSION_EXPIRED,
  CLOUD_AI_SESSION_TRANSIENT,
  CLOUD_AI_MOCK,
  AI_QUEUE_TIMEOUT,
  AI_TIMEOUT,
  AI_NETWORK,
  UPSTREAM_BUSY,
  AI_PROVIDER_MISCONFIGURED,
  ABORTED,
  IMAGE_TOO_LARGE,
  IMAGE_DECODE_FAILED,
  type AIRequestExtras,
  type DeepAnalysisResult,
  buildCloudAiHistory,
} from "../services/CloudAIService";
import { getLocationForAI } from "../utils/appPermissions";
import { cloudAIGuard } from "../utils/cloudAIGuard";
import { ensureEdgeSessionReadyDetailed, isUserLoggedIn, isServerAssignedId } from "../utils/auth";
import type { AIChatMessage } from "../components/ai/AIChatMessageList";

type AiStrings = Translations["ai"];

/**
 * 内部错误码 → 用户文案，避免展示 NOT_LOGGED_IN 等原始码。
 * `chat`：对话气泡；`detail`：深度分析错误卡片副标题（标题已是 deepAnalysisError，不再重复前缀）。
 */
function formatCloudAiError(raw: string, a: AiStrings, variant: "chat" | "detail"): string {
  const msg = (raw || "").trim();
  if (msg === CLOUD_AI_SESSION_EXPIRED || msg === "SESSION_EXPIRED") {
    return a.aiLoginRequired?.trim() || a.deepAnalysisError;
  }
  if (msg === CLOUD_AI_SESSION_TRANSIENT || msg === "SESSION_TRANSIENT") {
    return a.networkErrorHint || a.deepAnalysisError;
  }
  if (msg === "NOT_LOGGED_IN") {
    const hint = a.cloudAiNotLoggedInHint?.trim();
    if (!hint) return a.deepAnalysisError;
    return variant === "chat" ? `${a.deepAnalysisError} ${hint}` : hint;
  }
  if (msg === "DAILY_LIMIT_REACHED") return a.dailyLimitReached;
  if (msg === "IMAGE_TOO_SMALL") return a.imageTooSmall;
  if (msg === IMAGE_TOO_LARGE || msg === IMAGE_DECODE_FAILED) {
    return a.imageUnreadable || a.imageTooSmall;
  }
  if (msg === AI_TIMEOUT || msg === UPSTREAM_BUSY || msg === AI_QUEUE_TIMEOUT) return a.serverBusyTimeout;
  if (msg === AI_PROVIDER_MISCONFIGURED) return a.providerMisconfigured || a.deepAnalysisError;
  if (msg === AI_NETWORK) return a.networkErrorHint || a.deepAnalysisError;
  if (msg === ABORTED) return a.deepAnalysisError;
  const cd = /^COOLDOWN:(\d+)$/.exec(msg);
  if (cd) return a.cooldownWait.replace(/\{seconds\}/g, cd[1]!);
  if (msg === "RATE_LIMITED" || msg === "CHAT_TOO_FAST") return a.chatMessageTooFast;
  return msg || a.deepAnalysisError;
}

function isCloudAiTransportError(err: unknown): boolean {
  const e = err as { message?: unknown; name?: unknown } | null | undefined;
  const msg = typeof e?.message === "string" ? e.message : "";
  return (
    msg === AI_NETWORK ||
    msg === AI_TIMEOUT ||
    msg === ABORTED ||
    msg.includes("Failed to fetch") ||
    msg.includes("NetworkError") ||
    msg.includes("offline") ||
    e?.name === "TypeError"
  );
}

function isSessionExpiredError(raw: string): boolean {
  const msg = (raw || "").trim();
  return msg === CLOUD_AI_SESSION_EXPIRED || msg === "SESSION_EXPIRED";
}

function isSessionTransientError(raw: string): boolean {
  const msg = (raw || "").trim();
  return msg === CLOUD_AI_SESSION_TRANSIENT || msg === "SESSION_TRANSIENT";
}

// Blob → `data:audio/webm;base64,...`（用于直接把录音发给 Gemini 音频直发路径）
function blobToBase64DataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** GPS 仅首诊附带；追问/语音/追图不再上报坐标。 */
async function buildAIRequestExtras(opts?: { includeLocation?: boolean }): Promise<AIRequestExtras | undefined> {
  try {
    if (opts?.includeLocation !== true) return undefined;
    const loc = await getLocationForAI();
    if (!loc) return undefined;
    return {
      locationContext: {
        latitude: loc.latitude,
        longitude: loc.longitude,
        accuracyMeters: loc.accuracyMeters,
      },
    };
  } catch {
    return undefined;
  }
}

export type DeepAnalysisRequest = {
  image: string;
  detections: { className: string; score: number }[];
  /** 网络类失败时调用：返回要展示的错误文案；已改为展示本地结果时返回 null。 */
  onTransportError: () => Promise<string | null>;
};

type CloudAIConversationOptions = {
  a: AiStrings;
  language: Language;
  cloudAIConfig: CloudAIConfig | undefined;
};

/**
 * 云端 AI 会话：首诊、文字/语音/追图追问、错误文案映射、冷却与每日额度刷新、Edge 会话续期。
 * 本地 ONNX 兜底与 UI 状态留在页面，经 `onTransportError` / `showLocalAnalysis` 接入。
 */
export function useCloudAIConversation({ a, language, cloudAIConfig }: CloudAIConversationOptions) {
  const cloudAiEnabled = cloudAIConfig?.enabled === true;

  const needsAuthSession = useMemo(
    () => cloudAiEnabled && cloudAIUsesBackend() && isUserLoggedIn() && isServerAssignedId(),
    [cloudAiEnabled],
  );
  const [sessionReady, setSessionReady] = useState(() => !needsAuthSession);
  const [needsReverify, setNeedsReverify] = useState(false);

  // Deep Analysis state
  const [deepAnalysisResult, setDeepAnalysisResult] = useState<DeepAnalysisResult | null>(null);
  const [deepAnalyzing, setDeepAnalyzing] = useState(false);
  const [queueWaitSeconds, setQueueWaitSeconds] = useState(0);
  const [deepError, setDeepError] = useState('');
  const [deepErrorNoRetry, setDeepErrorNoRetry] = useState(false);
  const [isLocalAIResult, setIsLocalAIResult] = useState(false); // Track if current result is from local AI
  const deepAnalysisInFlightRef = useRef(false);
  const aiAnalysisGenRef = useRef(0);

  // Anti-abuse guard state
  const [cooldownSec, setCooldownSec] = useState(0);
  const [dailyUsage, setDailyUsage] = useState({ used: 0, limit: 20 });
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isUnlimited = dailyUsage.limit >= 999;

  /** 追问/语音/追图连发：与 `cloudAIConfig` 中「追问最小间隔」或「调用间隔（秒）」一致 */
  const chatFollowUpMinIntervalMs = useMemo(() => {
    const fromChat = cloudAIConfig?.clientChatMinIntervalSeconds;
    const fromCooldown = cloudAIConfig?.clientCooldownSeconds;
    const sec =
      typeof fromChat === "number" && Number.isFinite(fromChat) && fromChat >= 0
        ? fromChat
        : typeof fromCooldown === "number" && Number.isFinite(fromCooldown) && fromCooldown >= 0
          ? fromCooldown
          : 20;
    return Math.max(1000, Math.min(600_000, Math.floor(sec) * 1000));
  }, [cloudAIConfig?.clientChatMinIntervalSeconds, cloudAIConfig?.clientCooldownSeconds]);

  // Follow-up chat state
  const [chatMessages, setChatMessages] = useState<AIChatMessage[]>([]);
  const [chatReplying, setChatReplying] = useState(false);

  // 语音气泡里保存的是 URL.createObjectURL 生成的临时 URL，卸载时统一 revoke，避免内存泄漏。
  const chatMessagesRef = useRef(chatMessages);
  useEffect(() => { chatMessagesRef.current = chatMessages; }, [chatMessages]);
  useEffect(() => {
    return () => {
      for (const m of chatMessagesRef.current) {
        if (m.audioUrl && m.audioUrl.startsWith('blob:')) {
          try { URL.revokeObjectURL(m.audioUrl); } catch { /* ignore */ }
        }
      }
    };
  }, []);

  const lastChatFollowUpAtRef = useRef(0);
  const isChatFollowUpTooFast = useCallback((): boolean => {
    const now = Date.now();
    return lastChatFollowUpAtRef.current > 0 && now - lastChatFollowUpAtRef.current < chatFollowUpMinIntervalMs;
  }, [chatFollowUpMinIntervalMs]);
  const markChatFollowUp = useCallback(() => {
    lastChatFollowUpAtRef.current = Date.now();
  }, []);

  // Refresh guard state
  const refreshGuardState = useCallback(() => {
    setDailyUsage(cloudAIGuard.getDailyUsage());
    const cd = cloudAIGuard.getCooldownRemaining();
    setCooldownSec(cd);
    if (cd > 0 && !cooldownRef.current) {
      cooldownRef.current = setInterval(() => {
        const remaining = cloudAIGuard.getCooldownRemaining();
        setCooldownSec(remaining);
        setDailyUsage(cloudAIGuard.getDailyUsage());
        if (remaining <= 0 && cooldownRef.current) {
          clearInterval(cooldownRef.current);
          cooldownRef.current = null;
        }
      }, 1000);
    }
  }, []);

  // Init guard state + cleanup
  useEffect(() => {
    refreshGuardState();
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
      aiAnalysisGenRef.current += 1;
      cloudAIService.abortInFlight();
    };
  }, []);

  useEffect(() => {
    cloudAIService.onQueueWait = (_attempt, waitSeconds) => {
      setQueueWaitSeconds(waitSeconds);
    };
    return () => {
      cloudAIService.onQueueWait = null;
      setQueueWaitSeconds(0);
    };
  }, []);

  // When remote config updates client limits, refresh usage display
  useEffect(() => {
    refreshGuardState();
  }, [
    cloudAIConfig?.clientDailyLimit,
    cloudAIConfig?.clientCooldownSeconds,
    refreshGuardState,
  ]);

  // 打开 AI / 回前台：静默续期 JWT，cloud-only 首诊须 sessionReady
  useEffect(() => {
    if (!needsAuthSession) {
      setSessionReady(true);
      setNeedsReverify(false);
      return;
    }
    let cancelled = false;
    const syncSession = async () => {
      const { token, failureKind } = await ensureEdgeSessionReadyDetailed();
      if (cancelled) return;
      setSessionReady(!!token || failureKind === 'transient');
      setNeedsReverify(failureKind === 'permanent');
    };
    void syncSession();
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncSession();
    };
    const onPageShow = () => { void syncSession(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [needsAuthSession]);

  /** 首诊。成功返回云端结果；失败、已在进行中或被新一轮 / 重置取代时返回 null。 */
  const runDeepAnalysis = async ({ image, detections, onTransportError }: DeepAnalysisRequest): Promise<DeepAnalysisResult | null> => {
    if (deepAnalysisInFlightRef.current) return null;
    deepAnalysisInFlightRef.current = true;
    const gen = ++aiAnalysisGenRef.current;
    setDeepAnalyzing(true);
    setDeepError('');
    setDeepErrorNoRetry(false);
    setDeepAnalysisResult(null);

    try {
      const aiExtras = await buildAIRequestExtras({ includeLocation: true });
      const result = await cloudAIService.analyze(image, detections, language, aiExtras, (delta) => {
        if (gen !== aiAnalysisGenRef.current) return;
        setDeepAnalysisResult((prev) => ({
          provider: prev?.provider || '',
          model: prev?.model || '',
          analysis: (prev?.analysis || '') + delta,
          timestamp: prev?.timestamp || Date.now(),
        }));
      });
      if (gen !== aiAnalysisGenRef.current) return null;
      setDeepAnalysisResult(result);
      setIsLocalAIResult(false); // Mark as cloud AI result
      refreshGuardState();
      return result;
    } catch (err: any) {
      if (gen !== aiAnalysisGenRef.current) return null;
      const msg = err?.message || '';
      if (msg === ABORTED) return null;
      if (msg === 'CLOUD_AI_DISABLED' || msg.includes('CLOUD_AI_DISABLED')) {
        setDeepError(a.cloudAiDisabled);
        refreshGuardState();
        return null;
      }
      if (msg === CLOUD_AI_MOCK || msg.includes(CLOUD_AI_MOCK)) {
        setDeepError(
          language === 'zh' || language === 'zh-TW'
            ? '云端 AI 后端未配置，无法提供真实分析。'
            : 'Cloud AI backend is not configured. Real analysis is unavailable.',
        );
        refreshGuardState();
        return null;
      }
      if (isCloudAiTransportError(err) && cloudAiEnabled) {
        const fallbackError = await onTransportError();
        if (fallbackError) setDeepError(fallbackError);
      } else {
        if (isSessionExpiredError(msg)) setNeedsReverify(true);
        else if (isSessionTransientError(msg)) setNeedsReverify(false);
        setDeepErrorNoRetry(msg === AI_PROVIDER_MISCONFIGURED);
        setDeepError(formatCloudAiError(msg, a, "detail"));
      }
      refreshGuardState();
      return null;
    } finally {
      if (gen === aiAnalysisGenRef.current) {
        deepAnalysisInFlightRef.current = false;
        setDeepAnalyzing(false);
        setQueueWaitSeconds(0);
      }
    }
  };

  /** 本地 ONNX 生成的报告：作为首诊结果展示，但不支持追问。 */
  const showLocalAnalysis = useCallback((analysis: string) => {
    setDeepAnalysisResult({
      analysis,
      provider: 'local',
      model: 'onnx',
      timestamp: Date.now(),
    });
    setIsLocalAIResult(true);
  }, []);

  const appendAiMessage = useCallback((text: string) => {
    setChatMessages((prev) => [...prev, { role: 'ai', text }]);
  }, []);

  const withHistory = (extras?: AIRequestExtras): AIRequestExtras => ({
    ...extras,
    history: buildCloudAiHistory(chatMessagesRef.current),
  });

  const appendDeltaToLastAi = (delta: string) => {
    setChatMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last?.role === 'ai') {
        next[next.length - 1] = { ...last, text: last.text + delta };
        return next;
      }
      return [...next, { role: 'ai', text: delta }];
    });
  };

  const replaceLastAi = (text: string) => {
    setChatMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last?.role === 'ai') {
        next[next.length - 1] = { ...last, text };
        return next;
      }
      return [...next, { role: 'ai', text }];
    });
  };

  const sendChatImage = async (imgSrc: string) => {
    if (isChatFollowUpTooFast()) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'user', text: '', image: imgSrc },
        { role: 'ai', text: a.chatMessageTooFast },
      ]);
      return;
    }
    markChatFollowUp();
    setChatMessages(prev => [...prev, { role: 'user', text: '', image: imgSrc }]);
    if (!cloudAiEnabled) {
      setChatMessages(prev => [...prev, { role: 'ai', text: `⚠️ ${a.cloudAiDisabled}` }]);
      return;
    }
    setChatReplying(true);
    setChatMessages(prev => [...prev, { role: 'ai', text: '' }]);
    try {
      const aiExtras = withHistory(await buildAIRequestExtras());
      const reply = await cloudAIService.followUpWithImage(
        imgSrc,
        '[User sent a follow-up photo for further analysis]',
        deepAnalysisResult?.analysis || '',
        language,
        aiExtras,
        appendDeltaToLastAi,
      );
      replaceLastAi(reply);
      refreshGuardState();
    } catch (err: any) {
      const msg = err?.message || '';
      const isNetworkError = isCloudAiTransportError(err);
      const errorMsg = (isNetworkError && cloudAiEnabled)
        ? a.networkErrorHint
        : formatCloudAiError(msg, a, "chat");
      replaceLastAi(`⚠️ ${errorMsg}`);
      refreshGuardState();
    } finally {
      setChatReplying(false);
    }
  };

  /** 文字追问（与语音转写成功后共用） */
  const submitFollowUpText = useCallback(async (msg: string) => {
    const trimmed = msg.trim();
    if (!trimmed || !deepAnalysisResult || chatReplying || deepAnalyzing) return;

    if (isChatFollowUpTooFast()) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'user' as const, text: trimmed },
        { role: 'ai', text: a.chatMessageTooFast },
      ]);
      return;
    }
    markChatFollowUp();

    setChatMessages((prev) => [...prev, { role: 'user' as const, text: trimmed }]);

    if (isLocalAIResult) {
      setChatMessages((prev) => [...prev, { role: 'ai', text: a.localAINoVoice }]);
      return;
    }
    if (!cloudAiEnabled) {
      setChatMessages((prev) => [...prev, { role: 'ai', text: `⚠️ ${a.cloudAiDisabled}` }]);
      return;
    }

    setChatReplying(true);
    setChatMessages((prev) => [...prev, { role: 'ai', text: '' }]);
    try {
      const aiExtras = withHistory(await buildAIRequestExtras());
      const reply = await cloudAIService.followUp(trimmed, deepAnalysisResult.analysis, language, aiExtras, appendDeltaToLastAi);
      replaceLastAi(reply);
      refreshGuardState();
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : '';
      const isNetworkError = isCloudAiTransportError(err);
      const errorMsg =
        isNetworkError && cloudAiEnabled ? a.networkErrorHint : formatCloudAiError(m, a, "chat");
      if (isSessionExpiredError(m)) setNeedsReverify(true);
      else if (isSessionTransientError(m)) setNeedsReverify(false);
      replaceLastAi(`⚠️ ${errorMsg}`);
      refreshGuardState();
    } finally {
      setChatReplying(false);
    }
  }, [
    a,
    chatReplying,
    cloudAiEnabled,
    deepAnalysisResult,
    deepAnalyzing,
    isLocalAIResult,
    isChatFollowUpTooFast,
    language,
    markChatFollowUp,
    refreshGuardState,
  ]);

  /** 语音追问（Gemini 音频直发）：气泡保留录音 blob URL 供回放。 */
  const sendVoiceAudio = useCallback(async (blob: Blob, durationSec: number) => {
    const audioUrl = URL.createObjectURL(blob);
    if (isChatFollowUpTooFast()) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'user' as const, text: '', voiceDuration: durationSec, audioUrl },
        { role: 'ai', text: a.chatMessageTooFast },
      ]);
      return;
    }
    markChatFollowUp();
    setChatMessages((prev) => [
      ...prev,
      { role: 'user' as const, text: '', voiceDuration: durationSec, audioUrl },
    ]);

    if (isLocalAIResult) {
      setChatMessages((prev) => [...prev, { role: 'ai', text: a.localAINoVoice }]);
      return;
    }
    if (!cloudAiEnabled) {
      setChatMessages((prev) => [...prev, { role: 'ai', text: `⚠️ ${a.cloudAiDisabled}` }]);
      return;
    }

    setChatReplying(true);
    setChatMessages((prev) => [...prev, { role: 'ai', text: '' }]);
    try {
      const audioBase64 = await blobToBase64DataUrl(blob);
      const extras = await buildAIRequestExtras();
      const aiExtras: AIRequestExtras = {
        ...extras,
        history: buildCloudAiHistory([
          ...chatMessagesRef.current,
          { role: 'user', text: '', voiceDuration: durationSec },
        ]),
      };
      const reply = await cloudAIService.voiceFollowUp(audioBase64, deepAnalysisResult?.analysis || '', language, aiExtras, appendDeltaToLastAi);
      replaceLastAi(reply);
      refreshGuardState();
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : '';
      const isNetworkError = isCloudAiTransportError(err);
      const errorMsg =
        isNetworkError && cloudAiEnabled ? a.networkErrorHint : formatCloudAiError(m, a, "chat");
      replaceLastAi(`⚠️ ${errorMsg}`);
      refreshGuardState();
    } finally {
      setChatReplying(false);
    }
  }, [
    a,
    cloudAiEnabled,
    deepAnalysisResult,
    isLocalAIResult,
    isChatFollowUpTooFast,
    language,
    markChatFollowUp,
    refreshGuardState,
  ]);

  /** 放弃当前会话（含进行中的请求）；排队提示、needsReverify 与 deepErrorNoRetry 保持不变。 */
  const resetConversation = useCallback(() => {
    aiAnalysisGenRef.current += 1;
    cloudAIService.abortInFlight();
    deepAnalysisInFlightRef.current = false;
    setDeepAnalysisResult(null);
    setDeepAnalyzing(false);
    setDeepError('');
    setIsLocalAIResult(false);
    setChatMessages([]);
    setChatReplying(false);
  }, []);

  return {
    sessionReady,
    needsReverify,
    deepAnalysisResult,
    deepAnalyzing,
    queueWaitSeconds,
    deepError,
    deepErrorNoRetry,
    isLocalAIResult,
    chatMessages,
    chatMessagesRef,
    chatReplying,
    cooldownSec,
    dailyUsage,
    isUnlimited,
    runDeepAnalysis,
    showLocalAnalysis,
    appendAiMessage,
    sendChatImage,
    submitFollowUpText,
    sendVoiceAudio,
    resetConversation,
  };
}

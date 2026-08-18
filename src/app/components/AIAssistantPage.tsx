import { SecondaryView } from "./SecondaryView";
import { useLanguage, type Translations } from "../hooks/useLanguage";
import { useState, useRef, useEffect, useCallback, useMemo, type RefObject } from "react";
import { Camera, Loader, X, ScanLine, RefreshCw, AlertTriangle, FolderOpen, Play, Pause, Sparkles, Copy, Check, ChevronDown, ChevronUp, Send, Mic, PenLine, Image as ImageIcon, Volume2, VolumeX, MicOff } from "lucide-react";
import { TaprootAgroDetector, Detection } from "../utils/taprootAgroDetector";
import { useConfigContext } from "../hooks/ConfigProvider";
import { cloudAIService, cloudAIUsesBackend, CLOUD_AI_SESSION_EXPIRED, CLOUD_AI_SESSION_TRANSIENT, CLOUD_AI_MOCK, AI_QUEUE_TIMEOUT, type AIRequestExtras, type DeepAnalysisResult } from "../services/CloudAIService";
import { getLocationForAI, isAppPermissionEnabled } from "../utils/appPermissions";
import { cloudAIGuard } from "../utils/cloudAIGuard";
import { useKeyboardHeight } from "../hooks/useKeyboardHeight";
import { isNative, speechRecognition, textToSpeech, bridge, type WebSpeechHoldSession } from "../utils/capacitor-bridge";
import { languageToSpeechTag, speechTagFallbacks, ttsRateForLanguage } from "../utils/speechLocale";
import { storageGet, storageSet } from "../utils/safeStorage";
import { useNavigate } from "react-router";
import { ensureEdgeSessionReadyDetailed, isUserLoggedIn, isServerAssignedId } from "../utils/auth";
import { MockModeBanner } from "./MockModeBanner";
import { isProductionBuild } from "../utils/productionGuard";

const TTS_PREF_KEY = 'ai_tts_enabled';

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve(ev.target?.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

type AiStrings = Translations["ai"];

/** 对话气泡：避免展示 NOT_LOGGED_IN 等内部错误码 */
function formatCloudAiChatError(raw: string, a: AiStrings): string {
  const msg = (raw || "").trim();
  if (msg === CLOUD_AI_SESSION_EXPIRED || msg === "SESSION_EXPIRED") {
    return a.aiLoginRequired?.trim() || a.deepAnalysisError;
  }
  if (msg === CLOUD_AI_SESSION_TRANSIENT || msg === "SESSION_TRANSIENT") {
    return a.networkErrorHint || a.deepAnalysisError;
  }
  if (msg === "NOT_LOGGED_IN") {
    const hint = a.cloudAiNotLoggedInHint?.trim();
    return hint ? `${a.deepAnalysisError} ${hint}` : a.deepAnalysisError;
  }
  if (msg === "DAILY_LIMIT_REACHED") return a.dailyLimitReached;
  if (msg === "IMAGE_TOO_SMALL") return a.imageTooSmall;
  const cd = /^COOLDOWN:(\d+)$/.exec(msg);
  if (cd) return a.cooldownWait.replace(/\{seconds\}/g, cd[1]!);
  if (msg === "RATE_LIMITED" || msg === "CHAT_TOO_FAST") return a.chatMessageTooFast;
  if (msg === AI_QUEUE_TIMEOUT) return a.serverBusyTimeout;
  return msg || a.deepAnalysisError;
}

/** 深度分析错误卡片副标题（标题已是 deepAnalysisError） */
function formatCloudAiDeepErrorDetail(raw: string, a: AiStrings): string {
  const msg = (raw || "").trim();
  if (msg === CLOUD_AI_SESSION_EXPIRED || msg === "SESSION_EXPIRED") {
    return a.aiLoginRequired?.trim() || a.deepAnalysisError;
  }
  if (msg === CLOUD_AI_SESSION_TRANSIENT || msg === "SESSION_TRANSIENT") {
    return a.networkErrorHint || a.deepAnalysisError;
  }
  if (msg === "NOT_LOGGED_IN") {
    return a.cloudAiNotLoggedInHint?.trim() || a.deepAnalysisError;
  }
  if (msg === "DAILY_LIMIT_REACHED") return a.dailyLimitReached;
  if (msg === "IMAGE_TOO_SMALL") return a.imageTooSmall;
  const cd = /^COOLDOWN:(\d+)$/.exec(msg);
  if (cd) return a.cooldownWait.replace(/\{seconds\}/g, cd[1]!);
  if (msg === "RATE_LIMITED" || msg === "CHAT_TOO_FAST") return a.chatMessageTooFast;
  if (msg === AI_QUEUE_TIMEOUT) return a.serverBusyTimeout;
  return msg || a.deepAnalysisError;
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

// 按兼容顺序挑 MediaRecorder 支持的 mime
function pickAudioMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch { /* ignore */ }
  }
  return undefined;
}

interface AIAssistantPageProps {
  onClose: () => void;
}

type Status = 'idle' | 'loading' | 'ready' | 'no-model' | 'error' | 'cloud-only' | 'ai-disabled';

// Fix 5: 预生成波形条高度，避免在 render 中调用 Math.random()
const AI_WAVE_HEIGHTS = [1.5, 3, 2, 3.5, 1.5, 3, 2].map(h => h * 4);

export function AIAssistantPage({ onClose }: AIAssistantPageProps) {
  const { t, isRTL, language } = useLanguage();
  const { config } = useConfigContext();
  const a = t.ai;
  const navigate = useNavigate();
  const { isKeyboardOpen } = useKeyboardHeight();

  /** GPS 仅首诊附带；追问/语音/追图不再上报坐标。 */
  const buildAIRequestExtras = useCallback(
    async (opts?: { includeLocation?: boolean }): Promise<AIRequestExtras | undefined> => {
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
    },
    [],
  );

  // Cloud-only mode: when cloud AI is enabled AND device is online, skip local model
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const cloudAiEnabled = config.cloudAIConfig?.enabled === true;
  const enableLocalModel = config.aiModelConfig?.enableLocalModel === true;
  const cloudOnlyMode = cloudAiEnabled && isOnline;

  const needsAuthSession = useMemo(() => {
    const guest = config.cloudAIConfig?.allowUnauthenticatedUse === true;
    return (
      cloudAiEnabled &&
      cloudAIUsesBackend() &&
      !guest &&
      isUserLoggedIn() &&
      isServerAssignedId()
    );
  }, [cloudAiEnabled, config.cloudAIConfig?.allowUnauthenticatedUse]);

  const [sessionReady, setSessionReady] = useState(() => !needsAuthSession);
  const [needsReverify, setNeedsReverify] = useState(false);

  // 仅 Gemini 走"音频直发 → 多模态识别理解"；其他提供商（Qwen 等）维持原有的本地 STT → 文字流程。
  // 客户端拿不到 Edge 的 AI_PROVIDER secret，因此以「内容管理 → AI 模型」里填写的 modelId / providerName 为准。
  const modelIdLower = (config.cloudAIConfig?.modelId || '').toLowerCase();
  const providerNameLower = (config.cloudAIConfig?.providerName || '').toLowerCase();
  const useDirectAudio =
    modelIdLower.includes('gemini') || providerNameLower.includes('gemini');

  // 系统相机 input ref
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const [image, setImage] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState(0);
  const [detecting, setDetecting] = useState(false);
  const [results, setResults] = useState<Detection[]>([]);
  const [done, setDone] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Deep Analysis state
  const [deepAnalysisResult, setDeepAnalysisResult] = useState<DeepAnalysisResult | null>(null);
  const [deepAnalyzing, setDeepAnalyzing] = useState(false);
  const [queueWaitSeconds, setQueueWaitSeconds] = useState(0);
  const [deepError, setDeepError] = useState('');
  const [deepExpanded, setDeepExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const [isLocalAIResult, setIsLocalAIResult] = useState(false); // Track if current result is from local AI

  // Anti-abuse guard state
  const [cooldownSec, setCooldownSec] = useState(0);
  const [dailyUsage, setDailyUsage] = useState({ used: 0, limit: 20 });
  const [cachedHit, setCachedHit] = useState(false);
  const [cooldownHint, setCooldownHint] = useState(false);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isUnlimited = dailyUsage.limit >= 999;

  /** 追问/语音/追图连发：与 `cloudAIConfig` 中「追问最小间隔」或「调用间隔（秒）」一致 */
  const chatFollowUpMinIntervalMs = useMemo(() => {
    const c = config.cloudAIConfig;
    const fromChat = c?.clientChatMinIntervalSeconds;
    const fromCooldown = c?.clientCooldownSeconds;
    const sec =
      typeof fromChat === "number" && Number.isFinite(fromChat) && fromChat >= 0
        ? fromChat
        : typeof fromCooldown === "number" && Number.isFinite(fromCooldown) && fromCooldown >= 0
          ? fromCooldown
          : 20;
    return Math.max(1000, Math.min(600_000, Math.floor(sec) * 1000));
  }, [config.cloudAIConfig?.clientChatMinIntervalSeconds, config.cloudAIConfig?.clientCooldownSeconds]);

  // Follow-up chat state
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'ai'; text: string; image?: string; voiceDuration?: number; audioUrl?: string }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatReplying, setChatReplying] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  const lastChatFollowUpAtRef = useRef(0);
  const isChatFollowUpTooFast = useCallback((): boolean => {
    const now = Date.now();
    return lastChatFollowUpAtRef.current > 0 && now - lastChatFollowUpAtRef.current < chatFollowUpMinIntervalMs;
  }, [chatFollowUpMinIntervalMs]);
  const markChatFollowUp = useCallback(() => {
    lastChatFollowUpAtRef.current = Date.now();
  }, []);


  // Voice message playback state (for waveform animation)
  const [playingVoiceIdx, setPlayingVoiceIdx] = useState<number | null>(null);
  const voicePlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);

  const stopCurrentVoice = useCallback(() => {
    if (voiceAudioRef.current) {
      voiceAudioRef.current.pause();
      voiceAudioRef.current.currentTime = 0;
      voiceAudioRef.current = null;
    }
    if (voicePlayTimerRef.current) {
      clearTimeout(voicePlayTimerRef.current);
      voicePlayTimerRef.current = null;
    }
  }, []);

  const toggleVoicePlay = useCallback((idx: number, duration: number) => {
    if (playingVoiceIdx === idx) {
      stopCurrentVoice();
      setPlayingVoiceIdx(null);
    } else {
      stopCurrentVoice();
      setPlayingVoiceIdx(idx);

      // Try real audio playback if audioUrl exists
      const msg = chatMessages[idx];
      const audioUrl = msg?.audioUrl;

      if (audioUrl) {
        try {
          const audio = new Audio(audioUrl);
          voiceAudioRef.current = audio;

          audio.onended = () => {
            setPlayingVoiceIdx(null);
            voiceAudioRef.current = null;
            if (voicePlayTimerRef.current) { clearTimeout(voicePlayTimerRef.current); voicePlayTimerRef.current = null; }
          };

          audio.onerror = () => {
            console.warn('[AI Voice] Audio playback error');
            setPlayingVoiceIdx(null);
            voiceAudioRef.current = null;
          };

          audio.play().catch(() => {
            setPlayingVoiceIdx(null);
            voiceAudioRef.current = null;
          });

          // Safety timeout
          voicePlayTimerRef.current = setTimeout(() => {
            if (voiceAudioRef.current) { voiceAudioRef.current.pause(); voiceAudioRef.current = null; }
            setPlayingVoiceIdx(null);
          }, (duration + 2) * 1000);
        } catch {
          // Fallback to visual-only
          voicePlayTimerRef.current = setTimeout(() => setPlayingVoiceIdx(null), duration * 1000);
        }
      } else {
        // No audio URL — visual animation only
        voicePlayTimerRef.current = setTimeout(() => setPlayingVoiceIdx(null), duration * 1000);
      }
    }
  }, [playingVoiceIdx, chatMessages, stopCurrentVoice]);

  // Input mode: default voice, user can switch to text via pen icon
  const [inputMode, setInputMode] = useState<'voice' | 'text'>('voice');

  // Voice recording state
  const [isVoiceRecording, setIsVoiceRecording] = useState(false);
  const [voiceTime, setVoiceTime] = useState(0);
  const voiceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Refs mirror state for touch handlers (avoid stale closures)
  const isVoiceRecordingRef = useRef(false);
  const voiceTimeRef = useRef(0);
  /** 按下瞬间时间戳，用于真实按住时长（避免 1s 定时器导致 <1s 全被当成 0） */
  const voiceHoldStartedAtRef = useRef(0);

  /** Web：按住说话时的 Web Speech 会话；App：松手后在 handleVoiceRecordEnd 里调原生 start */
  const webSpeechSessionRef = useRef<WebSpeechHoldSession | null>(null);
  const lastVoiceDurationRef = useRef(0);

  // Gemini 音频直发路径：录制原始音频 Blob，base64 后交给 cloudAIService.voiceFollowUp。
  // Qwen 及其它提供商继续走 STT → 文字流程，这些 ref 不会被触及。
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const directAudioActiveRef = useRef(false);
  /** Gemini 路径：getUserMedia + recorder.start 完成后再允许 stop（解决权限弹窗慢于松手） */
  const directAudioReadyRef = useRef<Promise<void> | null>(null);
  /** 本次按住是否走 Gemini 直录（勿用 directAudioActiveRef 判断分支：出错时它会被提前清掉） */
  const voiceUseDirectAudioRef = useRef(false);

  // Voice cancel-pending state (finger dragged outside button)
  const [voiceCancelPending, setVoiceCancelPendingState] = useState(false);
  const voiceCancelPendingRef = useRef(false);
  const setVoiceCancelPending = useCallback((pending: boolean) => {
    voiceCancelPendingRef.current = pending;
    setVoiceCancelPendingState(pending);
  }, []);

  const [micPermissionDenied, setMicPermissionDenied] = useState(false);
  /** Web Speech 不可用（如 Safari） */
  const [sttError, setSttError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      webSpeechSessionRef.current?.abort();
      webSpeechSessionRef.current = null;
      // Gemini 直发路径：卸载时务必释放麦克风，避免后台常开
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => {
          try { t.stop(); } catch { /* ignore */ }
        });
        mediaStreamRef.current = null;
      }
      if (mediaRecorderRef.current) {
        try {
          if (mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
          }
        } catch { /* ignore */ }
        mediaRecorderRef.current = null;
      }
      audioChunksRef.current = [];
      directAudioActiveRef.current = false;
    };
  }, []);

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

  // 语音录制是否可用（Fix 4: 只有 deepAnalysisResult 存在且 AI 没在回复时才可录音）
  const voiceEnabled = !!deepAnalysisResult && !chatReplying && !deepAnalyzing && !isLocalAIResult && cloudAiEnabled;

  // TTS auto-read state — 持久化到 safeStorage，默认 ON
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(() => {
    const raw = storageGet(TTS_PREF_KEY);
    if (raw === 'false') return false;
    return true;
  });
  useEffect(() => {
    storageSet(TTS_PREF_KEY, ttsEnabled ? 'true' : 'false');
  }, [ttsEnabled]);

  // 正在朗读 / 已暂停 —— 驱动顶栏 UI
  const [ttsSpeaking, setTtsSpeaking] = useState(false);
  const [ttsPaused, setTtsPaused] = useState(false);

  // 当前朗读任务的 Abort 句柄；开启新一次朗读前先 abort 旧任务 + stop 引擎
  const ttsAbortRef = useRef<AbortController | null>(null);

  // Strip markdown for cleaner TTS reading
  const stripMarkdown = useCallback((md: string): string => {
    return md
      .replace(/#{1,6}\s*/g, '')           // headings
      .replace(/\*\*([^*]+)\*\*/g, '$1')   // bold
      .replace(/\*([^*]+)\*/g, '$1')       // italic
      .replace(/`([^`]+)`/g, '$1')         // inline code
      .replace(/```[\s\S]*?```/g, '')      // code blocks
      .replace(/>\s?/g, '')                // blockquotes
      .replace(/[-*+]\s/g, '')             // list bullets
      .replace(/\d+\.\s/g, '')             // numbered lists
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
      .replace(/\n{2,}/g, '. ')            // paragraph breaks → pause
      .replace(/\n/g, ' ')
      .trim();
  }, []);

  // 打断当前朗读（抛弃队列 + 引擎 stop），不改变 ttsEnabled
  const stopTTS = useCallback(() => {
    if (ttsAbortRef.current) {
      ttsAbortRef.current.abort();
      ttsAbortRef.current = null;
    }
    textToSpeech.stop().catch(() => { /* ignore */ });
    setTtsSpeaking(false);
    setTtsPaused(false);
  }, []);

  // 朗读入口：按当前 UI 语言分句串播；force=true 绕过 ttsEnabled
  const speakText = useCallback((text: string, force = false) => {
    if (!ttsEnabled && !force) return;
    const clean = stripMarkdown(text);
    if (!clean) return;

    // 打断旧任务
    if (ttsAbortRef.current) ttsAbortRef.current.abort();
    textToSpeech.stop().catch(() => { /* ignore */ });

    const controller = new AbortController();
    ttsAbortRef.current = controller;
    setTtsSpeaking(true);
    setTtsPaused(false);

    const lang = languageToSpeechTag(language);
    textToSpeech
      .speakQueue(clean, {
        lang,
        langFallbacks: speechTagFallbacks(language),
        rate: ttsRateForLanguage(language),
        pitch: 1.0,
        signal: controller.signal,
      })
      .finally(() => {
        // 只有当当前任务仍是最新任务时才清空 speaking 状态
        if (ttsAbortRef.current === controller) {
          ttsAbortRef.current = null;
          setTtsSpeaking(false);
          setTtsPaused(false);
        }
      });
  }, [ttsEnabled, stripMarkdown, language]);

  // Cleanup TTS on unmount
  useEffect(() => {
    return () => { stopTTS(); };
  }, [stopTTS]);

  // 静音开关：关闭时立即打断正在播的
  const toggleTTS = useCallback(() => {
    setTtsEnabled(prev => {
      if (prev) stopTTS();
      return !prev;
    });
  }, [stopTTS]);

  // 暂停 / 恢复（与静音开关独立）
  const togglePauseResume = useCallback(() => {
    if (!ttsSpeaking) return;
    if (ttsPaused) {
      textToSpeech.resume().catch(() => { /* ignore */ });
      setTtsPaused(false);
    } else {
      textToSpeech.pause().catch(() => { /* ignore */ });
      setTtsPaused(true);
    }
  }, [ttsSpeaking, ttsPaused]);

  // 点击某条 AI 文字气泡 → 强制朗读（自动开启 TTS 并打断旧朗读）
  const handleAITextClick = useCallback((text: string) => {
    stopTTS();
    if (!ttsEnabled) setTtsEnabled(true);
    speakText(text, true);
  }, [ttsEnabled, speakText, stopTTS]);

  // Camera menu state (for chat bar)
  const [showCamMenu, setShowCamMenu] = useState(false);
  const chatFileRef = useRef<HTMLInputElement>(null);
  const chatCameraRef = useRef<HTMLInputElement>(null);

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
    config.cloudAIConfig?.clientDailyLimit,
    config.cloudAIConfig?.clientCooldownSeconds,
    refreshGuardState,
  ]);

  // Listen for online/offline changes
  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Helper: format guard translation strings
  const guardText = useCallback((template: string, vars: Record<string, string | number>) => {
    let result = template;
    for (const [k, v] of Object.entries(vars)) {
      result = result.replace(`{${k}}`, String(v));
    }
    return result;
  }, []);

  const fileRef = useRef<HTMLInputElement>(null);
  const detectorRef = useRef<TaprootAgroDetector | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pendingDrawRef = useRef<{ img: HTMLImageElement; dets: Detection[] } | null>(null);
  /** 断网时从 cloud-only 切本地模型只尝试一次，避免 loadModel 失败导致循环 */
  const offlineLocalLoadTried = useRef(false);

  // 加载模型
  // Silent background loading (for cloud-only mode)
  const silentLoadModel = useCallback(async () => {
    if (!config.aiModelConfig?.enableLocalModel) return;
    // Skip if already loaded
    if (detectorRef.current) {
      console.log('✅ [Cloud Mode] Model already loaded, skipping background load');
      return;
    }
    
    try {
      const aiCfg = config.aiModelConfig;
      if (!aiCfg?.modelUrl) {
        console.log('⚠️ [Cloud Mode] No model URL configured, skipping background load');
        return;
      }
      
      console.log('🔍 [Cloud Mode] Background loading local model for emergency fallback...');
      const detector = new TaprootAgroDetector({
        modelUrl: aiCfg.modelUrl,
        labelsUrl: aiCfg.labelsUrl || '',
      });
      await detector.loadModel();
      detectorRef.current = detector;
      console.log('✅ [Cloud Mode] Local model loaded in background');
    } catch (err: any) {
      console.log('⚠️ [Cloud Mode] Background model load failed (will try again on network error):', err?.message);
      // Silently fail - we'll try again if network actually fails
    }
  }, [config.aiModelConfig]);

  // Normal loading with UI feedback (for local mode)
  const loadModel = useCallback(async () => {
    if (!config.aiModelConfig?.enableLocalModel) {
      setErrorMsg(a.localAiOffCannotLoad);
      return;
    }
    if (detectorRef.current) {
      setStatus('ready');
      return;
    }
    setStatus('loading');
    setProgress(0);
    setErrorMsg('');

    try {
      const aiCfg = config.aiModelConfig;
      const detector = new TaprootAgroDetector({
        modelUrl: aiCfg?.modelUrl || '',
        labelsUrl: aiCfg?.labelsUrl || '',
      });
      detector.setProgressCallback((p) => setProgress(p));
      await detector.loadModel();
      detectorRef.current = detector;
      setStatus('ready');
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.log('🔍 Model load error:', msg);
      // 云 AI 开启但本地模型拉取失败：在线可走纯云端；离线应提示配置本地模型，避免卡在「仅云端」壳
      if (config.cloudAIConfig?.enabled && typeof navigator !== 'undefined' && navigator.onLine) {
        setStatus('cloud-only');
      } else {
        setStatus('no-model');
      }
    }
  }, [config.aiModelConfig, config.cloudAIConfig?.enabled, a.localAiOffCannotLoad]);

  // Initialize: load model based on mode (only runs once on mount)
  useEffect(() => {
    const cloudOn = config.cloudAIConfig?.enabled === true;
    const localOn = config.aiModelConfig?.enableLocalModel === true;
    const online = typeof navigator !== 'undefined' && navigator.onLine;
    const cOnly = cloudOn && online;

    if (!cloudOn && !localOn) {
      setStatus('ai-disabled');
      return;
    }
    if (cOnly) {
      setStatus('cloud-only');
      if (localOn) silentLoadModel();
      return;
    }
    if (localOn) {
      loadModel();
      return;
    }
    if (cloudOn && !online) {
      setStatus('no-model');
      setErrorMsg(a.offlineCloudOnlyNoLocal);
      return;
    }
    setStatus('no-model');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

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

  const goToReverifyLogin = useCallback(() => {
    navigate("/login", { state: { from: "aiAssistant" } });
  }, [navigate]);

  // 断网时从「仅云端」壳切到本地 ONNX（避免长期停在 cloud-only 且无法完整使用本地能力）
  useEffect(() => {
    if (isOnline) {
      offlineLocalLoadTried.current = false;
      return;
    }
    if (status !== 'cloud-only') return;
    if (detectorRef.current) {
      setStatus('ready');
      return;
    }
    if (!config.aiModelConfig?.enableLocalModel) return;
    if (offlineLocalLoadTried.current) return;
    offlineLocalLoadTried.current = true;
    loadModel();
  }, [isOnline, status, loadModel, config.aiModelConfig?.enableLocalModel]);

  // Cloud-only mode: auto-trigger analysis as soon as image is set (after session ready)
  const autoTriggeredRef = useRef(false);
  useEffect(() => {
    if (!sessionReady) return;
    if (cloudOnlyMode && image && !autoTriggeredRef.current && !deepAnalyzing && !deepAnalysisResult && !deepError) {
      autoTriggeredRef.current = true;
      handleDeepAnalysis(true);
    }
    if (!image) {
      autoTriggeredRef.current = false;
    }
  }, [image, cloudOnlyMode, sessionReady]);

  // 系统相机拍照 — Native 优先走 bridge.camera，失败回退 file input
  const applyPhotoDataUrl = useCallback((dataUrl: string) => {
    setImage(dataUrl);
    setResults([]);
    setDone(false);
  }, []);

  const takePhotoViaNativeOrFile = useCallback(async (fileInputRef: RefObject<HTMLInputElement | null>) => {
    if (isNative()) {
      try {
        const photo = await bridge.camera.takePhoto({
          source: 'camera',
          quality: 80,
          width: 1920,
        });
        if (photo) {
          const dataUrl = await bridge.camera.photoToDataUrl(photo);
          if (dataUrl) {
            applyPhotoDataUrl(dataUrl);
            return;
          }
        }
      } catch {
        /* fall through to file input */
      }
    }
    fileInputRef.current?.click();
  }, [applyPhotoDataUrl]);

  const onCameraFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      applyPhotoDataUrl(await readFileAsDataUrl(f));
    } catch {
      /* ignore */
    }
    if (cameraInputRef.current) cameraInputRef.current.value = '';
  };

  // 选图 — 压缩在 CloudAIService.prepareImageForCloudAI 中统一执行一次
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      setImage(await readFileAsDataUrl(f));
      setResults([]);
      setDone(false);
    } catch {
      /* ignore */
    }
  };

  // ===== 对话中系统相机拍照 → 追加图片给AI =====
  const onChatCameraFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setShowCamMenu(false);
    let imgSrc: string;
    try {
      imgSrc = await readFileAsDataUrl(f);
    } catch {
      if (chatCameraRef.current) chatCameraRef.current.value = '';
      return;
    }
    if (chatCameraRef.current) chatCameraRef.current.value = '';
    // 作为用户消息发送图片
    setChatMessages(prev => [...prev, { role: 'user', text: '', image: imgSrc }]);
    if (!cloudAiEnabled) {
      setChatMessages(prev => [...prev, { role: 'ai', text: `⚠️ ${a.cloudAiDisabled}` }]);
      return;
    }
    // 自动发给AI进行追问
    setChatReplying(true);
    try {
      const previousContext = (deepAnalysisResult?.analysis || '') +
        chatMessages.map(m => `\n\n[${m.role === 'user' ? 'User' : 'AI'}]: ${m.image ? '[Photo]' : m.text}`).join('');
      const aiExtras = await buildAIRequestExtras();
      const reply = await cloudAIService.followUpWithImage(
        imgSrc,
        '[User sent a follow-up photo for further analysis]',
        previousContext,
        language,
        aiExtras,
      );
      setChatMessages(prev => [...prev, { role: 'ai', text: reply }]);
      refreshGuardState();
    } catch (err: any) {
      const msg = err?.message || '';
      const isNetworkError = msg.includes('network') || msg.includes('fetch') || msg.includes('Failed to fetch') || 
                             msg.includes('NetworkError') || msg.includes('offline') || err?.name === 'TypeError';
      const cloudAIEnabled = config.cloudAIConfig?.enabled === true;
      const errorMsg = (isNetworkError && cloudAIEnabled)
        ? a.networkErrorHint
        : formatCloudAiChatError(msg, a);
      setChatMessages(prev => [...prev, { role: 'ai', text: `⚠️ ${errorMsg}` }]);
      refreshGuardState();
    } finally {
      setChatReplying(false);
    }
  };

  const onChatFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setShowCamMenu(false);
    try {
      const imgSrc = await readFileAsDataUrl(f);
      sendChatImage(imgSrc);
    } catch {
      /* ignore */
    }
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
    try {
      const previousContext = (deepAnalysisResult?.analysis || '') +
        chatMessages.map(m => `\n\n[${m.role === 'user' ? 'User' : 'AI'}]: ${m.image ? '[Photo]' : m.text}`).join('');
      const aiExtras = await buildAIRequestExtras();
      const reply = await cloudAIService.followUpWithImage(
        imgSrc,
        '[User sent a follow-up photo for further analysis]',
        previousContext,
        language,
        aiExtras,
      );
      setChatMessages(prev => [...prev, { role: 'ai', text: reply }]);
      refreshGuardState();
    } catch (err: any) {
      const msg = err?.message || '';
      const isNetworkError = msg.includes('network') || msg.includes('fetch') || msg.includes('Failed to fetch') || 
                             msg.includes('NetworkError') || msg.includes('offline') || err?.name === 'TypeError';
      const cloudAIEnabled = config.cloudAIConfig?.enabled === true;
      const errorMsg = (isNetworkError && cloudAIEnabled)
        ? a.networkErrorHint
        : formatCloudAiChatError(msg, a);
      setChatMessages(prev => [...prev, { role: 'ai', text: `⚠️ ${errorMsg}` }]);
      refreshGuardState();
    } finally {
      setChatReplying(false);
    }
  };

  // Generate local AI analysis from detection results (only when cloud AI enabled but network failed)
  const generateLocalAnalysis = (dets: Detection[], isNetworkFallback = false) => {
    if (dets.length === 0) return;
    
    let analysis = '';
    
    if (isNetworkFallback) {
      analysis += `⚠️ **${a.networkErrorHint}**\n\n`;
      analysis += `📱 **本地AI初步诊断结果**（不支持对话功能）\n\n`;
      analysis += `---\n\n`;
    }
    
    analysis += `## ${a.detected} ${dets.length} ${a.targets}\n\n`;
    
    dets.forEach((det, idx) => {
      const confidence = (det.score * 100).toFixed(1);
      analysis += `### ${idx + 1}. ${det.className}\n\n`;
      analysis += `**Confidence**: ${confidence}%\n\n`;
      analysis += `**Detection**: ${det.className}\n\n`;
      analysis += `**Recommendations**:\n`;
      analysis += `- Regular crop inspection and early detection\n`;
      analysis += `- Maintain proper field ventilation and humidity control\n`;
      analysis += `- Apply appropriate pesticides as needed\n`;
      analysis += `- Remove diseased plant materials to prevent spread\n\n`;
    });
    
    analysis += `---\n\n`;
    
    if (isNetworkFallback) {
      analysis += `💡 **${a.localAINoVoice}**\n\n`;
      analysis += `📶 **网络问题**：信号较差，已使用本地AI进行初步诊断。\n\n`;
      analysis += `🔄 **建议**：请保存照片，等信号良好时重新拍照检测，使用云端AI获取详细分析和对话功能。\n\n`;
      analysis += `---\n\n`;
    } else {
      analysis += `💡 **${a.localAINoVoice}**\n\n`;
      analysis += `---\n\n`;
    }
    
    analysis += `${a.disclaimer}`;
    
    // Set as deep analysis result
    setDeepAnalysisResult({
      analysis,
      provider: 'local',
      model: 'onnx',
      timestamp: Date.now(),
    });
    setDeepExpanded(true);
    setIsLocalAIResult(true); // Mark as local AI result
    
    // Auto-read analysis (both local-only mode and network fallback mode)
    speakText(analysis);
  };

  // 真实识别
  const handleDetect = async () => {
    if (!enableLocalModel || !image || !detectorRef.current) return;
    setDetecting(true);
    setResults([]);
    setDone(false);

    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = image;
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; });

      const dets = await detectorRef.current.detect(img);
      setResults(dets);
      setDone(true);
      pendingDrawRef.current = { img, dets };
      
      // Auto-generate analysis when online AI is off but local ONNX is on
      if (!cloudAiEnabled && enableLocalModel && dets.length > 0) {
        generateLocalAnalysis(dets, false);
      }
    } catch (err) {
      console.error(err);
      setDone(true);
    } finally {
      setDetecting(false);
    }
  };

  // 画检测框
  const drawBoxes = (img: HTMLImageElement, dets: Detection[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);

    const colors = ['#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899'];

    dets.forEach((det, i) => {
      const [x1, y1, x2, y2] = det.bbox;
      const bx = x1 * w, by = y1 * h, bw = (x2 - x1) * w, bh = (y2 - y1) * h;
      const color = colors[i % colors.length];

      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.004);
      ctx.setLineDash([]);
      ctx.strokeRect(bx, by, bw, bh);

      ctx.fillStyle = color + '15';
      ctx.fillRect(bx, by, bw, bh);

      const label = `${det.className} ${(det.score * 100).toFixed(0)}%`;
      const fontSize = Math.max(14, Math.min(w, h) * 0.025);
      ctx.font = `bold ${fontSize}px sans-serif`;
      const textW = ctx.measureText(label).width;
      const pad = fontSize * 0.35;
      const labelH = fontSize + pad * 2;

      const labelY = by - labelH > 0 ? by - labelH : by;

      ctx.fillStyle = color;
      ctx.beginPath();
      const r = 4;
      ctx.roundRect(bx, labelY, textW + pad * 2, labelH, [r, r, r, r]);
      ctx.fill();

      ctx.fillStyle = '#fff';
      ctx.fillText(label, bx + pad, labelY + fontSize + pad * 0.3);
    });
  };

  const reset = () => {
    setImage(null);
    setResults([]);
    setDone(false);
    setDeepAnalysisResult(null);
    setDeepAnalyzing(false);
    setDeepError('');
    setCopied(false);
    setIsLocalAIResult(false);
    setChatMessages([]);
    setChatInput('');
    setChatReplying(false);
    setPlayingVoiceIdx(null);
    stopCurrentVoice();
    // 重置录音 refs
    isVoiceRecordingRef.current = false;
    voiceTimeRef.current = 0;
    if (voiceTimerRef.current) { clearInterval(voiceTimerRef.current); voiceTimerRef.current = null; }
    if (fileRef.current) fileRef.current.value = '';
    if (cameraInputRef.current) cameraInputRef.current.value = '';
  };

  useEffect(() => {
    if (done && results.length > 0 && pendingDrawRef.current) {
      const pending = pendingDrawRef.current;
      const raf = requestAnimationFrame(() => {
        if (canvasRef.current) {
          drawBoxes(pending.img, pending.dets);
          pendingDrawRef.current = null;
        }
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [done, results]);

  // Deep Analysis handler (unified for both local+cloud and cloud-only modes)
  const handleDeepAnalysis = async (forceCloudOnly = false) => {
    if (!image) return;
    // In cloud-only mode or forced cloud-only, we don't require local detection results
    const isCloudOnly = cloudOnlyMode || forceCloudOnly;
    if (!isCloudOnly && results.length === 0) return;
    setDeepAnalyzing(true);
    setDeepError('');
    setDeepAnalysisResult(null);
    setDeepExpanded(true);
    setCachedHit(false);

    try {
      const detections = isCloudOnly ? [] : results.map((d) => ({ className: d.className, score: d.score }));
      const aiExtras = await buildAIRequestExtras({ includeLocation: true });
      const result = await cloudAIService.analyze(image, detections, language, aiExtras);
      setDeepAnalysisResult(result);
      setIsLocalAIResult(false); // Mark as cloud AI result
      if (isCloudOnly) setDone(true);
      refreshGuardState();
      // Auto-read the initial analysis
      speakText(result.analysis);
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg === 'CLOUD_AI_DISABLED' || msg.includes('CLOUD_AI_DISABLED')) {
        setDeepError(a.cloudAiDisabled);
        refreshGuardState();
        return;
      }
      if (msg === CLOUD_AI_MOCK || msg.includes(CLOUD_AI_MOCK)) {
        setDeepError(
          language === 'zh' || language === 'zh-TW'
            ? '云端 AI 后端未配置，无法提供真实分析。'
            : 'Cloud AI backend is not configured. Real analysis is unavailable.',
        );
        refreshGuardState();
        return;
      }
      // Check if it's a network error and cloud AI is enabled
      const isNetworkError = msg.includes('network') || msg.includes('fetch') || msg.includes('Failed to fetch') || 
                             msg.includes('NetworkError') || msg.includes('offline') || err?.name === 'TypeError';
      if (isNetworkError && cloudAiEnabled && !isCloudOnly && results.length > 0 && enableLocalModel) {
        // Scenario 3a: Network error with cloud AI enabled + local results already available
        // Fallback to local AI with network warning
        generateLocalAnalysis(results, true);
      } else if (isNetworkError && cloudAiEnabled && isCloudOnly && enableLocalModel) {
        // Scenario 3b: Cloud-only mode network error - fallback to local detection
        // (Model should already be loaded in background, but load if needed)
        try {
          // Ensure local model is loaded (should already be loaded from background)
          if (!detectorRef.current) {
            console.log('⚠️ Background model not ready, loading now...');
            const aiCfg = config.aiModelConfig;
            const detector = new TaprootAgroDetector({
              modelUrl: aiCfg?.modelUrl || '',
              labelsUrl: aiCfg?.labelsUrl || '',
            });
            await detector.loadModel();
            detectorRef.current = detector;
          } else {
            console.log('✅ Using background-loaded model for fallback');
          }
          
          // Run local detection
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.src = image;
          await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; });
          const dets = await detectorRef.current!.detect(img);
          setResults(dets);
          setDone(true);
          pendingDrawRef.current = { img, dets };
          if (dets.length > 0) {
            generateLocalAnalysis(dets, true);
          } else {
            setDeepError(a.networkErrorHint);
          }
        } catch (localErr) {
          // Local detection also failed
          setDeepError(a.networkErrorHint);
        }
      } else if (isNetworkError && cloudAiEnabled && isCloudOnly && !enableLocalModel) {
        setDeepError(a.offlineCloudOnlyNoLocal);
      } else if (isNetworkError && cloudAiEnabled) {
        // Network error but no local model available
        setDeepError(a.networkErrorHint);
      } else {
        if (isSessionExpiredError(msg)) setNeedsReverify(true);
        else if (isSessionTransientError(msg)) setNeedsReverify(false);
        setDeepError(formatCloudAiDeepErrorDetail(msg, a));
      }
      refreshGuardState();
    } finally {
      setDeepAnalyzing(false);
      setQueueWaitSeconds(0);
    }
  };

  // Cloud-only shorthand
  const handleCloudAnalysis = () => handleDeepAnalysis(true);

  // Copy report to clipboard
  const handleCopyReport = async () => {
    if (!deepAnalysisResult) return;
    try {
      await navigator.clipboard.writeText(deepAnalysisResult.analysis);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = deepAnalysisResult.analysis;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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
    try {
      const fullContext =
        deepAnalysisResult.analysis +
        chatMessages.map((m) => `\n\n[${m.role === 'user' ? 'User' : 'AI'}]: ${m.text}`).join('') +
        `\n\n[User]: ${trimmed}`;
      const aiExtras = await buildAIRequestExtras();
      const reply = await cloudAIService.followUp(trimmed, fullContext, language, aiExtras);
      setChatMessages((prev) => [...prev, { role: 'ai', text: reply }]);
      refreshGuardState();
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : '';
      const isNetworkError =
        m.includes('network') ||
        m.includes('fetch') ||
        m.includes('Failed to fetch') ||
        m.includes('NetworkError') ||
        m.includes('offline') ||
        (err as { name?: string })?.name === 'TypeError';
      const cloudAIEnabled = config.cloudAIConfig?.enabled === true;
      const errorMsg =
        isNetworkError && cloudAIEnabled ? a.networkErrorHint : formatCloudAiChatError(m, a);
      if (isSessionExpiredError(m)) setNeedsReverify(true);
      else if (isSessionTransientError(m)) setNeedsReverify(false);
      setChatMessages((prev) => [...prev, { role: 'ai', text: `⚠️ ${errorMsg}` }]);
      refreshGuardState();
    } finally {
      setChatReplying(false);
    }
  }, [
    a.chatMessageTooFast,
    a.cloudAiDisabled,
    a.cloudAiNotLoggedInHint,
    a.cooldownWait,
    a.dailyLimitReached,
    a.deepAnalysisError,
    a.localAINoVoice,
    a.networkErrorHint,
    chatMessages,
    chatReplying,
    cloudAiEnabled,
    deepAnalysisResult,
    deepAnalyzing,
    isLocalAIResult,
    isChatFollowUpTooFast,
    language,
    markChatFollowUp,
    config.cloudAIConfig?.enabled,
    refreshGuardState,
  ]);

  const handleChatSend = async () => {
    const msg = chatInput.trim();
    if (!msg || !deepAnalysisResult || chatReplying || deepAnalyzing) return;
    setChatInput('');
    if (chatInputRef.current) {
      chatInputRef.current.style.height = '48px';
    }
    await submitFollowUpText(msg);
  };

  const handleVoiceRecordEndRef = useRef<() => Promise<void>>(async () => {});

  // 彻底释放麦克风 — Gemini 直发路径所有退出路径都必须调用
  const releaseMediaStream = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => {
        try { track.stop(); } catch { /* ignore */ }
      });
      mediaStreamRef.current = null;
    }
    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      } catch { /* ignore */ }
      mediaRecorderRef.current = null;
    }
    audioChunksRef.current = [];
    directAudioActiveRef.current = false;
  }, []);

  // 等 MediaRecorder 的 onstop 触发并把 chunks 拼成 Blob；超时兜底
  const stopRecorderAndGetBlob = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder) {
        resolve(null);
        return;
      }
      if (recorder.state === 'inactive') {
        const blob = audioChunksRef.current.length
          ? new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
          : null;
        resolve(blob);
        return;
      }
      const timeout = setTimeout(() => {
        const blob = audioChunksRef.current.length
          ? new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
          : null;
        resolve(blob);
      }, 1500);
      recorder.onstop = () => {
        clearTimeout(timeout);
        const blob = audioChunksRef.current.length
          ? new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
          : null;
        resolve(blob);
      };
      try {
        // 确保最后一小段音频进入 ondataavailable（部分浏览器松手即停会丢尾包）
        try {
          (recorder as MediaRecorder & { requestData?: () => void }).requestData?.();
        } catch { /* ignore */ }
        recorder.stop();
      } catch {
        clearTimeout(timeout);
        resolve(null);
      }
    });
  }, []);

  const handleVoiceRecordEnd = useCallback(async () => {
    if (!isVoiceRecordingRef.current) return;
    const elapsedMs = Math.max(0, performance.now() - voiceHoldStartedAtRef.current);
    // 真实按住秒数（用于气泡展示）；逻辑最短时长用 elapsedMs，不用 1s 步进定时器
    const durationSec = Math.max(1, Math.round(elapsedMs / 1000));
    const wasCancelled = voiceCancelPendingRef.current;
    const wasDirectAudio = voiceUseDirectAudioRef.current;
    lastVoiceDurationRef.current = durationSec;
    isVoiceRecordingRef.current = false;
    voiceCancelPendingRef.current = false;
    setIsVoiceRecording(false);
    setVoiceCancelPendingState(false);
    if (voiceTimerRef.current) {
      clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }

    // 过短视为误触（约 <0.4s）；原先用 voiceTimeRef<1 会误伤「按住 0.6s」等短句
    if (wasCancelled || elapsedMs < 400) {
      voiceUseDirectAudioRef.current = false;
      if (wasDirectAudio) {
        directAudioReadyRef.current = null;
        releaseMediaStream();
      } else if (!isNative()) {
        webSpeechSessionRef.current?.abort();
        webSpeechSessionRef.current = null;
      }
      voiceTimeRef.current = 0;
      setVoiceTime(0);
      return;
    }

    // ═══ Gemini 音频直发分支 ═══
    if (wasDirectAudio) {
      // 先等麦克风 + MediaRecorder 就绪（权限弹窗可能比松手晚，不能在 getUserMedia 里用 isVoiceRecordingRef 判断取消）
      try {
        const ready = directAudioReadyRef.current;
        if (ready) {
          await Promise.race([
            ready,
            new Promise<void>((_, rej) =>
              setTimeout(() => rej(new Error('direct_audio_ready_timeout')), 20000),
            ),
          ]);
        }
      } catch (e) {
        console.warn('[AI Voice] direct audio not ready', e);
        releaseMediaStream();
        directAudioReadyRef.current = null;
        voiceUseDirectAudioRef.current = false;
        const msg = e instanceof Error ? e.message : '';
        if (msg === 'direct_audio_ready_timeout') {
          setChatMessages((prev) => [...prev, { role: 'ai', text: `⚠️ ${a.sttNoResult}` }]);
        } else {
          setMicPermissionDenied(true);
          setTimeout(() => setMicPermissionDenied(false), 3000);
        }
        voiceTimeRef.current = 0;
        setVoiceTime(0);
        return;
      }
      directAudioReadyRef.current = null;

      let blob: Blob | null = null;
      try {
        blob = await stopRecorderAndGetBlob();
      } catch (e) {
        console.warn('[AI Voice] stop recorder failed', e);
      } finally {
        releaseMediaStream();
      }

      if (!blob || blob.size === 0) {
        voiceUseDirectAudioRef.current = false;
        setChatMessages((prev) => [...prev, { role: 'ai', text: `⚠️ ${a.sttNoResult}` }]);
        voiceTimeRef.current = 0;
        setVoiceTime(0);
        return;
      }

      const audioUrl = URL.createObjectURL(blob);
      if (isChatFollowUpTooFast()) {
        setChatMessages((prev) => [
          ...prev,
          { role: 'user' as const, text: '', voiceDuration: durationSec, audioUrl },
          { role: 'ai', text: a.chatMessageTooFast },
        ]);
        voiceTimeRef.current = 0;
        setVoiceTime(0);
        voiceUseDirectAudioRef.current = false;
        return;
      }
      markChatFollowUp();
      setChatMessages((prev) => [
        ...prev,
        { role: 'user' as const, text: '', voiceDuration: durationSec, audioUrl },
      ]);

      if (isLocalAIResult) {
        voiceUseDirectAudioRef.current = false;
        setChatMessages((prev) => [...prev, { role: 'ai', text: a.localAINoVoice }]);
        voiceTimeRef.current = 0;
        setVoiceTime(0);
        return;
      }
      if (!cloudAiEnabled) {
        voiceUseDirectAudioRef.current = false;
        setChatMessages((prev) => [...prev, { role: 'ai', text: `⚠️ ${a.cloudAiDisabled}` }]);
        voiceTimeRef.current = 0;
        setVoiceTime(0);
        return;
      }

      setChatReplying(true);
      try {
        const audioBase64 = await blobToBase64DataUrl(blob);
        const fullContext =
          (deepAnalysisResult?.analysis || '') +
          chatMessages
            .map((m) => `\n\n[${m.role === 'user' ? 'User' : 'AI'}]: ${m.text}`)
            .join('') +
          `\n\n[User]: (voice message, ${durationSec}s)`;
        const aiExtras = await buildAIRequestExtras();
        const reply = await cloudAIService.voiceFollowUp(audioBase64, fullContext, language, aiExtras);
        setChatMessages((prev) => [...prev, { role: 'ai', text: reply }]);
        refreshGuardState();
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : '';
        const isNetworkError =
          m.includes('network') ||
          m.includes('fetch') ||
          m.includes('Failed to fetch') ||
          m.includes('NetworkError') ||
          m.includes('offline') ||
          (err as { name?: string })?.name === 'TypeError';
        const errorMsg =
          isNetworkError && cloudAiEnabled ? a.networkErrorHint : formatCloudAiChatError(m, a);
        setChatMessages((prev) => [...prev, { role: 'ai', text: `⚠️ ${errorMsg}` }]);
        refreshGuardState();
      } finally {
        setChatReplying(false);
        voiceTimeRef.current = 0;
        setVoiceTime(0);
      }
      voiceUseDirectAudioRef.current = false;
      return;
    }

    // ═══ 现有 STT 分支（Qwen / native / 其它） ═══
    try {
      let matches: string[] = [];
      if (isNative()) {
        matches = await speechRecognition.start({
          language: languageToSpeechTag(language),
          popup: true,
        });
      } else {
        const sess = webSpeechSessionRef.current;
        webSpeechSessionRef.current = null;
        matches = sess ? await sess.stop() : [];
      }

      const text = (matches[0] || '').trim();
      if (!text) {
        setChatMessages((prev) => [...prev, { role: 'ai', text: `⚠️ ${a.sttNoResult}` }]);
        voiceTimeRef.current = 0;
        setVoiceTime(0);
        return;
      }

      await submitFollowUpText(text);
    } catch (e) {
      console.warn('[AI Voice STT]', e);
      setChatMessages((prev) => [...prev, { role: 'ai', text: `⚠️ ${a.sttFailed}` }]);
    } finally {
      voiceUseDirectAudioRef.current = false;
      voiceTimeRef.current = 0;
      setVoiceTime(0);
    }
  }, [
    language,
    a.sttNoResult,
    a.sttFailed,
    a.chatMessageTooFast,
    a.localAINoVoice,
    a.cloudAiDisabled,
    a.cloudAiNotLoggedInHint,
    a.cooldownWait,
    a.dailyLimitReached,
    a.networkErrorHint,
    a.deepAnalysisError,
    submitFollowUpText,
    releaseMediaStream,
    stopRecorderAndGetBlob,
    deepAnalysisResult,
    chatMessages,
    cloudAiEnabled,
    isLocalAIResult,
    isChatFollowUpTooFast,
    markChatFollowUp,
    refreshGuardState,
  ]);

  const handleVoiceRecordStart = useCallback(() => {
    if (isVoiceRecordingRef.current) return;
    if (!deepAnalysisResult || chatReplying || deepAnalyzing) return;
    if (!isAppPermissionEnabled('microphone')) {
      setMicPermissionDenied(true);
      setTimeout(() => setMicPermissionDenied(false), 3000);
      return;
    }
    stopTTS();
    setMicPermissionDenied(false);
    setSttError(null);
    voiceHoldStartedAtRef.current = performance.now();
    voiceUseDirectAudioRef.current = useDirectAudio;
    isVoiceRecordingRef.current = true;
    voiceTimeRef.current = 0;
    voiceCancelPendingRef.current = false;
    setIsVoiceRecording(true);
    setVoiceCancelPendingState(false);
    setVoiceTime(0);

    // ═══ Gemini 音频直发：MediaRecorder 录制 webm/opus，松手后 base64 化上传 ═══
    if (useDirectAudio) {
      directAudioActiveRef.current = true;
      directAudioReadyRef.current = null;
      audioChunksRef.current = [];
      const mimeType = pickAudioMimeType();

      directAudioReadyRef.current = new Promise<void>((resolve, reject) => {
        navigator.mediaDevices
          .getUserMedia({ audio: true })
          .then((stream) => {
            // 仅根据 directAudioActiveRef：松手时 handleVoiceRecordEnd 会先把 isVoiceRecordingRef 置 false，
            // 若仍用 isVoiceRecordingRef 会误判为「已取消」并永远建不成 MediaRecorder（权限弹窗慢时必现）。
            if (!directAudioActiveRef.current) {
              stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
              resolve();
              return;
            }
            mediaStreamRef.current = stream;
            const recorder = mimeType
              ? new MediaRecorder(stream, { mimeType })
              : new MediaRecorder(stream);
            recorder.ondataavailable = (e) => {
              if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
            };
            mediaRecorderRef.current = recorder;
            try {
              recorder.start(250);
              resolve();
            } catch (e) {
              console.warn('[AI Voice] recorder.start failed', e);
              releaseMediaStream();
              reject(e instanceof Error ? e : new Error('recorder_start_failed'));
            }
          })
          .catch((err) => {
            console.warn('[AI Voice] getUserMedia denied', err);
            directAudioActiveRef.current = false;
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });
    } else if (!isNative()) {
      // ═══ Qwen 及 Web 降级：保留原有 Web Speech STT 会话 ═══
      const sess = speechRecognition.startWebHoldSession({
        language: languageToSpeechTag(language),
      });
      if (!sess) {
        isVoiceRecordingRef.current = false;
        setIsVoiceRecording(false);
        setVoiceTime(0);
        setSttError(a.sttNotSupported);
        setTimeout(() => setSttError(null), 4000);
        return;
      }
      webSpeechSessionRef.current = sess;
    }
    // Native + 非 Gemini：沿用原逻辑，松手时在 handleVoiceRecordEnd 里调 speechRecognition.start

    voiceTimerRef.current = setInterval(() => {
      voiceTimeRef.current += 1;
      const t = voiceTimeRef.current;
      setVoiceTime(t);
      if (t >= 59) {
        if (voiceTimerRef.current) {
          clearInterval(voiceTimerRef.current);
          voiceTimerRef.current = null;
        }
        lastVoiceDurationRef.current = t;
        void handleVoiceRecordEndRef.current();
      }
    }, 1000);
  }, [
    stopTTS,
    deepAnalysisResult,
    chatReplying,
    deepAnalyzing,
    language,
    a.sttNotSupported,
    useDirectAudio,
    releaseMediaStream,
  ]);

  handleVoiceRecordEndRef.current = handleVoiceRecordEnd;

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, chatReplying]);

  // 键盘弹出时也滚动到底部，确保输入框可见
  useEffect(() => {
    if (isKeyboardOpen && chatEndRef.current) {
      setTimeout(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    }
  }, [isKeyboardOpen]);

  // Auto-read latest AI reply via TTS —— 用消息文本哈希去重，避免上下滚动/重渲触发
  const lastSpokenHashRef = useRef<string>('');
  useEffect(() => {
    if (!ttsEnabled || chatMessages.length === 0) return;
    const lastMsg = chatMessages[chatMessages.length - 1];
    if (lastMsg.role !== 'ai') return;
    const text = lastMsg.text?.trim();
    if (!text || text.startsWith('⚠️')) return;

    // 轻量哈希：DJB2（与 cloudAIGuard 简版同风格，无需 SubtleCrypto）
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h + text.charCodeAt(i)) & 0xffffffff;
    }
    const hash = h.toString(16);
    if (hash === lastSpokenHashRef.current) return;
    lastSpokenHashRef.current = hash;
    speakText(text);
  }, [chatMessages, ttsEnabled, speakText]);

  // Show cooldown hint temporarily
  const showCooldownHint = useCallback(() => {
    setCooldownHint(true);
    setTimeout(() => setCooldownHint(false), 2000);
  }, []);

  // Check if action should be blocked — limits removed, always allow
  const isBlocked = useCallback(() => {
    return false;
  }, []);

  const handleVoiceRecordEndSync = useCallback(() => {
    void handleVoiceRecordEnd();
  }, [handleVoiceRecordEnd]);

  const handleVoiceRecordCancel = useCallback(() => {
    if (!isVoiceRecordingRef.current) return;
    const wasDirectAudio = voiceUseDirectAudioRef.current;
    isVoiceRecordingRef.current = false;
    voiceCancelPendingRef.current = false;
    setIsVoiceRecording(false);
    setVoiceCancelPendingState(false);
    if (voiceTimerRef.current) {
      clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
    if (wasDirectAudio) {
      directAudioReadyRef.current = null;
      releaseMediaStream();
    } else if (!isNative()) {
      webSpeechSessionRef.current?.abort();
      webSpeechSessionRef.current = null;
    }
    voiceUseDirectAudioRef.current = false;
    voiceTimeRef.current = 0;
    setVoiceTime(0);
  }, [releaseMediaStream]);

  // Close camera menu on outside click
  useEffect(() => {
    if (!showCamMenu) return;
    const handleClick = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.cam-menu-container')) setShowCamMenu(false);
    };
    document.addEventListener('touchstart', handleClick);
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('touchstart', handleClick);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [showCamMenu]);

  // Simple markdown renderer for analysis text
  const renderMarkdown = (text: string) => {
    const lines = text.split('\n');
    return lines.map((line, i) => {
      // Headers
      if (line.startsWith('## ')) return <h2 key={i} className="text-base text-gray-900 mt-4 mb-2">{line.slice(3)}</h2>;
      if (line.startsWith('### ')) return <h3 key={i} className="text-sm text-gray-800 mt-3 mb-1">{line.slice(4)}</h3>;
      if (line.startsWith('#### ')) return <h4 key={i} className="text-xs text-gray-700 mt-2 mb-1">{line.slice(5)}</h4>;
      // Horizontal rule
      if (line.startsWith('---')) return <hr key={i} className="my-3 border-gray-200" />;
      // List items
      if (line.startsWith('- **')) {
        const match = line.match(/^- \*\*(.+?)\*\*[：:](.*)$/);
        if (match) return <p key={i} className="text-xs text-gray-600 ms-3 my-0.5"><span className="text-gray-800">{match[1]}</span>：{match[2]}</p>;
      }
      if (line.startsWith('- ')) return <p key={i} className="text-xs text-gray-600 ms-3 my-0.5">{line.slice(2)}</p>;
      // Numbered items
      if (/^\d+\.\s\*\*/.test(line)) {
        const match = line.match(/^(\d+)\.\s\*\*(.+?)\*\*[：:](.*)$/);
        if (match) return <p key={i} className="text-xs text-gray-600 ms-3 my-0.5"><span className="text-emerald-700">{match[1]}.</span> <span className="text-gray-800">{match[2]}</span>：{match[3]}</p>;
      }
      // Bold text
      if (line.includes('**')) {
        const parts = line.split(/\*\*(.+?)\*\*/g);
        return <p key={i} className="text-xs text-gray-600 my-0.5">{parts.map((part, j) => j % 2 === 1 ? <span key={j} className="text-gray-800">{part}</span> : part)}</p>;
      }
      // Italic/small text
      if (line.startsWith('*') && line.endsWith('*')) return <p key={i} className="text-[10px] text-gray-400 my-0.5 italic">{line.slice(1, -1)}</p>;
      // Empty line
      if (line.trim() === '') return <div key={i} className="h-1" />;
      // Normal text
      return <p key={i} className="text-xs text-gray-600 my-0.5">{line}</p>;
    });
  };

  // ===== 底部操作栏 — 通过 footer 插槽固定在叉号上方 =====
  const bottomBar = image ? (
    <div className="bg-white px-3 pt-3 pb-3 space-y-2 shadow-[0_-4px_16px_rgba(0,0,0,0.08)]">
      {/* 识别按钮 — 本地模式，未开始 */}
      {!done && !detecting && !cloudOnlyMode && enableLocalModel && (
        <button
          onClick={handleDetect}
          className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white py-3.5 rounded-2xl active:scale-[0.97] transition-transform shadow-lg shadow-emerald-200/50"
        >
          <ScanLine className="w-4 h-4" /><span className="font-medium">{a.startDetect}</span>
        </button>
      )}

      {/* 深度分析按钮 — 本地检测完成后（仅在开启云AI时显示） */}
      {done && results.length > 0 && !deepAnalysisResult && !deepAnalyzing && !deepError && cloudAiEnabled && (
        <>
          <button
            onClick={() => handleDeepAnalysis()}
            className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white py-3.5 rounded-2xl active:scale-[0.97] transition-transform shadow-lg shadow-emerald-200/50"
          >
            <Sparkles className="w-4 h-4" /><span className="font-medium">{a.deepAnalysis}</span>
          </button>
        </>
      )}

      {/* 分析中 — 仅非云端模式显示进度提示 */}
      {!cloudOnlyMode && (detecting || deepAnalyzing) && (
        <div className="flex items-center justify-center gap-2 py-2">
          <Loader className="w-4 h-4 text-emerald-500 animate-spin" />
          <span className="text-xs text-gray-500">{detecting ? a.aiAnalyzing : a.deepAnalyzing}</span>
        </div>
      )}

      {/* ═══ 聊天栏：默认语音模式，点笔切文字 ═══ */}
      {(deepAnalysisResult || (cloudOnlyMode && image)) && (
        <div className="flex flex-col gap-1 w-full">
          {sttError && (
            <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">{sttError}</p>
          )}
        <div className="flex items-end gap-2">
          {/* 左侧切换按钮：语音模式显示笔(切文字)，文字模式显示麦克风(切语音) */}
          <button
            onClick={() => setInputMode(inputMode === 'voice' ? 'text' : 'voice')}
            className="w-11 h-11 flex items-center justify-center bg-emerald-50 text-emerald-600 rounded-full active:scale-90 transition-all flex-shrink-0"
          >
            {inputMode === 'voice' ? <PenLine className="w-[18px] h-[18px]" /> : <Mic className="w-[18px] h-[18px]" />}
          </button>

          {/* ── 语音模式：按住说话按钮 ── */}
          {inputMode === 'voice' && (
            <div
              className="flex-1 min-w-0 select-none"
              style={{ height: '44px' }}
              onTouchStart={(e) => {
                if (!voiceEnabled || micPermissionDenied) return;
                const touch = e.touches[0];
                const rect = e.currentTarget.getBoundingClientRect();
                (e.currentTarget as any).__startY = touch?.clientY || 0;
                (e.currentTarget as any).__btnRect = rect;
                handleVoiceRecordStart();
              }}
              onTouchMove={(e) => {
                if (!isVoiceRecordingRef.current) return;
                const touch = e.touches[0];
                const rect = (e.currentTarget as any).__btnRect as DOMRect;
                if (!rect || !touch) return;
                const isOutside =
                  touch.clientX < rect.left - 20 ||
                  touch.clientX > rect.right + 20 ||
                  touch.clientY < rect.top - 20 ||
                  touch.clientY > rect.bottom + 20;
                if (isOutside !== voiceCancelPendingRef.current) {
                  setVoiceCancelPending(isOutside);
                }
              }}
              onTouchEnd={() => handleVoiceRecordEndSync()}
              onTouchCancel={() => handleVoiceRecordCancel()}
              onMouseDown={() => { if (voiceEnabled && !micPermissionDenied) handleVoiceRecordStart(); }}
              onMouseUp={() => handleVoiceRecordEndSync()}
              onMouseLeave={() => {
                if (isVoiceRecordingRef.current) {
                  setVoiceCancelPending(true);
                  handleVoiceRecordEndSync();
                }
              }}
            >
              {/* Fix 3: 麦克风权限被拒绝 */}
              {micPermissionDenied ? (
                <div className="bg-red-50 rounded-full text-center text-red-500 flex items-center justify-center shadow-sm" style={{ height: '44px', fontSize: 'clamp(11px, 3vw, 13px)' }}>
                  <MicOff className="w-4 h-4 inline-block me-1.5 flex-shrink-0" />
                  <span className="truncate">{a.micDenied || 'Microphone permission denied'}</span>
                </div>
              ) : !isVoiceRecording ? (
                /* Fix 4: voiceEnabled=false 时显示禁用态 + 提示 */
                <div className={`rounded-full text-center select-none flex items-center justify-center shadow-sm ${voiceEnabled ? 'bg-emerald-50 text-emerald-600 active:bg-emerald-500 active:text-white' : 'bg-gray-100 text-gray-400'} transition-colors`} style={{ height: '44px', fontSize: 'clamp(12px, 3.2vw, 14px)' }}>
                  <Mic className="w-4 h-4 inline-block me-1.5 flex-shrink-0" />
                  <span className="truncate">{voiceEnabled ? a.holdToSpeak : (deepAnalyzing ? (a.deepAnalyzing || 'Analyzing...') : (chatReplying ? (a.aiReplying || 'AI replying...') : a.holdToSpeak))}</span>
                </div>
              ) : (
                <div className={`${voiceCancelPending ? 'bg-red-500' : 'bg-emerald-500'} rounded-full px-3 flex items-center gap-2 transition-colors duration-150`} style={{ height: '44px' }}>
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <div className="flex items-end gap-[2px] h-4">
                      {/* Fix 5: 使用预计算的 AI_WAVE_HEIGHTS 替代 Math.random() */}
                      {AI_WAVE_HEIGHTS.map((h, i) => (
                        <div key={i} className="w-[3px] bg-white/70 rounded-full" style={voiceCancelPending ? {
                          height: `${h}px`,
                        } : {
                          height: `${h}px`,
                          animation: `voiceWave 0.4s ease-in-out ${i * 0.07}s infinite alternate`
                        }} />
                      ))}
                    </div>
                    <span className="text-sm text-white font-medium tabular-nums">{voiceTime}"</span>
                    <span className="text-[10px] text-white/60 tabular-nums">/ 60s</span>
                  </div>
                  <span className="text-[10px] text-white/80 flex-shrink-0">{a.releaseToSend}</span>
                </div>
              )}
            </div>
          )}

          {/* ── 文字模式：输入框 + 内嵌发送按钮 ── */}
          {inputMode === 'text' && (
            <div className="flex-1 min-w-0 relative" style={{ minHeight: '44px' }}>
              <textarea
                ref={chatInputRef}
                value={chatInput}
                onChange={(e) => {
                  setChatInput(e.target.value);
                  // Auto-resize: always reset to min height first
                  e.target.style.height = '44px';
                  // If content needs more space, expand (but only if not empty)
                  if (e.target.value && e.target.scrollHeight > 44) {
                    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                  }
                }}
                onKeyDown={(e) => { 
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleChatSend();
                  }
                }}
                placeholder={a.chatPlaceholder || '输入消息...'}
                disabled={chatReplying || deepAnalyzing || !deepAnalysisResult || (!isUnlimited && dailyUsage.used >= dailyUsage.limit)}
                rows={1}
                className={`w-full bg-emerald-50 rounded-full text-gray-700 placeholder-emerald-400 outline-none focus:ring-2 focus:ring-emerald-300 disabled:opacity-50 transition-all resize-none shadow-sm ${isRTL ? 'pr-11 pl-4' : 'pl-4 pr-11'}`}
                style={{ display: 'block', height: '44px', minHeight: '44px', maxHeight: '120px', paddingTop: '12px', paddingBottom: '12px', lineHeight: '20px', boxSizing: 'border-box', fieldSizing: 'fixed', fontSize: 'clamp(13px, 3.5vw, 15px)' } as React.CSSProperties}
              />
              {/* 发送按钮 — 仅文字模式有内容时显示，在输入框内部 */}
              {chatInput.trim() && (
                <button
                  onClick={handleChatSend}
                  disabled={chatReplying || deepAnalyzing || !deepAnalysisResult || (!isUnlimited && dailyUsage.used >= dailyUsage.limit)}
                  className={`absolute bottom-1.5 w-8 h-8 flex items-center justify-center active:scale-90 transition-all disabled:opacity-40 disabled:active:scale-100 ${isRTL ? 'left-1.5' : 'right-1.5'}`}
                >
                  <Send className="w-5 h-5 text-emerald-600" strokeWidth={2.5} />
                </button>
              )}
            </div>
          )}

          <div className="relative flex-shrink-0 cam-menu-container">
            <button
              onClick={() => setShowCamMenu(!showCamMenu)}
              className="w-11 h-11 flex items-center justify-center bg-emerald-50 text-emerald-600 rounded-full active:scale-90 transition-all flex-shrink-0 shadow-sm"
            >
              <Camera className="w-5 h-5" />
            </button>
            {showCamMenu && (
              <div className={`absolute bottom-full mb-2 bg-white rounded-2xl shadow-2xl py-2 z-20 w-40 overflow-hidden ${isRTL ? 'left-0' : 'right-0'}`}>
                <button
                  onClick={() => { setShowCamMenu(false); void takePhotoViaNativeOrFile(chatCameraRef); }}
                  className="w-full px-4 py-3 flex items-center gap-3 active:bg-gray-50 transition-colors"
                >
                  <Camera className="w-4 h-4 text-emerald-600" />
                  <span className="text-sm text-gray-700">{a.takePhoto}</span>
                </button>
                <div className="mx-3" style={{ height: '1px', background: 'linear-gradient(to right, transparent, rgba(0,0,0,0.06), transparent)' }} />
                <button
                  onClick={() => { setShowCamMenu(false); chatFileRef.current?.click(); }}
                  className="w-full px-4 py-3 flex items-center gap-3 active:bg-gray-50 transition-colors"
                >
                  <ImageIcon className="w-4 h-4 text-emerald-600" />
                  <span className="text-sm text-gray-700">{a.selectAlbum}</span>
                </button>
              </div>
            )}
            <input ref={chatCameraRef} type="file" accept="image/*" capture="environment" onChange={onChatCameraFile} className="hidden" />
            <input ref={chatFileRef} type="file" accept="image/*" onChange={onChatFile} className="hidden" />
          </div>
        </div>
        </div>
      )}



      {/* 重新拍照按钮 */}
      {done && !deepAnalysisResult && !deepAnalyzing && !deepError && results.length === 0 && !cloudOnlyMode && (
        <button
          onClick={reset}
          className="w-full flex items-center justify-center gap-2 bg-emerald-50 text-emerald-700 py-3.5 rounded-2xl active:scale-[0.97] transition-transform shadow-md shadow-emerald-100/40"
        >
          <Camera className="w-4 h-4" /><span className="font-medium">{a.retakePhoto}</span>
        </button>
      )}
    </div>
  ) : null;

  // ===== 渲 =====
  return (
    <SecondaryView
      onClose={onClose}
      title={t.home.aiAssistant}
      showTitle={true}
      footer={bottomBar}
      headerRight={
        (deepAnalysisResult || (cloudOnlyMode && image)) ? (
          <div className="flex items-center gap-1">
            {ttsSpeaking && (
              <button
                onClick={togglePauseResume}
                className="flex items-center justify-center w-9 h-9 active:scale-90 transition-all touch-manipulation rounded-xl"
                aria-label={ttsPaused ? 'Resume speech' : 'Pause speech'}
              >
                {ttsPaused
                  ? <Play className="w-5 h-5 text-emerald-600" strokeWidth={2} />
                  : <Pause className="w-5 h-5 text-emerald-600" strokeWidth={2} />
                }
              </button>
            )}
            <button
              onClick={toggleTTS}
              className={`flex items-center justify-center w-9 h-9 active:scale-90 transition-all touch-manipulation rounded-xl ${ttsEnabled ? '' : 'bg-emerald-100'}`}
              aria-label={ttsEnabled ? 'Mute' : 'Unmute'}
            >
              {ttsEnabled
                ? <Volume2 className="w-5 h-5 text-emerald-600" strokeWidth={2} />
                : <VolumeX className="w-5 h-5 text-emerald-600" strokeWidth={2} />
              }
            </button>
          </div>
        ) : undefined
      }
    >
      <div className={`flex flex-col ${!image && status !== 'no-model' && status !== 'ai-disabled' ? 'h-full overflow-hidden' : 'min-h-full'} ${deepAnalysisResult ? 'bg-gradient-to-b from-emerald-50 to-white' : ''}`} style={deepAnalysisResult ? {} : { backgroundColor: 'var(--app-bg)' }}>

        {isProductionBuild() && cloudAiEnabled && cloudAIService.mode === "mock" && (
          <MockModeBanner feature="ai" />
        )}

        {/* 顶部状态 */}
        <div className="px-4 pt-2 pb-1 flex-shrink-0">
          {status === 'loading' && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
              <div className="flex items-center gap-2 mb-1 min-w-0">
                <Loader className="w-3.5 h-3.5 text-emerald-600 animate-spin flex-shrink-0" />
                <span className="text-xs text-emerald-700 font-medium truncate min-w-0">{a.loadingModel}</span>
                <span className="text-[10px] text-emerald-500 ms-auto flex-shrink-0">{progress}%</span>
              </div>
              <div className="w-full bg-emerald-200 rounded-full h-1">
                <div className="bg-emerald-600 h-1 rounded-full transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}
          {status === 'ready' && (
            <div className="flex items-center gap-2 bg-emerald-50 rounded-xl px-3 py-2 min-w-0 shadow-sm">
              <div className="w-2 h-2 bg-emerald-500 rounded-full flex-shrink-0" />
              <span className="text-xs text-emerald-700 font-medium truncate min-w-0">{a.modelReady}</span>
              <span className="text-[10px] text-emerald-500 ms-auto flex-shrink-0 whitespace-nowrap">{detectorRef.current?.getLabels().length || 0} {a.classes}</span>
            </div>
          )}
          {status === 'error' && (
            <div className="flex items-center gap-2 bg-red-50 rounded-xl px-3 py-2 min-w-0 shadow-sm">
              <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
              <span className="text-xs text-red-600 truncate flex-1 min-w-0">{errorMsg || a.loadFailed}</span>
              <button onClick={loadModel} className="text-[10px] text-red-700 font-medium px-2 py-0.5 rounded bg-red-100 active:bg-red-200 flex-shrink-0 whitespace-nowrap">{a.retry}</button>
            </div>
          )}


          {/* 免责声明 — 仅在检测完成后显示 */}
          {done && (
            <div className="flex items-center gap-2 mt-2 px-3 py-2.5 bg-amber-50 rounded-xl shadow-md shadow-amber-100/60">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
              <p className="text-[11px] text-amber-700 leading-relaxed">{a.disclaimer}</p>
            </div>
          )}
        </div>

        {/* 主区域 — 可滚动 */}
        {status === 'ai-disabled' ? (
          <div className="flex-1 flex items-center justify-center px-5">
            <div className="w-full max-w-sm text-center">
              <div className="w-16 h-16 mx-auto mb-3 bg-amber-50 rounded-2xl flex items-center justify-center">
                <AlertTriangle className="w-8 h-8 text-amber-500" />
              </div>
              <h3 className="text-base font-bold text-gray-800 mb-1">{a.aiDisabledBothTitle}</h3>
              <p className="text-xs text-gray-500 leading-relaxed">{a.aiDisabledBothDesc}</p>
            </div>
          </div>
        ) : status === 'no-model' ? (
          <div className="flex-1 flex items-center justify-center px-5">
            <div className="w-full max-w-sm">
              <div className="text-center mb-5">
                <div className="w-16 h-16 mx-auto mb-3 bg-gray-100 rounded-2xl flex items-center justify-center">
                  <FolderOpen className="w-8 h-8 text-gray-400" />
                </div>
                <h3 className="text-base font-bold text-gray-800 mb-1">
                  {(cloudAiEnabled && !enableLocalModel && errorMsg) ? a.offlineNoAiTitle : a.noModel}
                </h3>
                <p className="text-xs text-gray-500">
                  {(cloudAiEnabled && !enableLocalModel && errorMsg) ? a.offlineCloudOnlyNoLocal : (errorMsg || a.noModelDesc)}
                </p>
              </div>

              {enableLocalModel ? (
                <>
                  <div className="bg-gray-50 rounded-xl p-3.5 mb-4 space-y-2 overflow-hidden">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <span className="w-5 h-5 bg-emerald-100 text-emerald-700 rounded-full text-center leading-5 text-[11px] font-bold flex-shrink-0">1</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-gray-700 break-words">{a.step1}</p>
                        <p className="text-[10px] text-gray-400 font-mono mt-0.5 break-all">python export_model.py --format onnx --imgsz 640</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2.5 min-w-0">
                      <span className="w-5 h-5 bg-emerald-100 text-emerald-700 rounded-full text-center leading-5 text-[11px] font-bold flex-shrink-0">2</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-gray-700 break-words">{a.step2}</p>
                        <p className="text-[10px] text-gray-400 font-mono mt-0.5 break-all">public/models/taprootagro.onnx</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2.5 min-w-0">
                      <span className="w-5 h-5 bg-emerald-100 text-emerald-700 rounded-full text-center leading-5 text-[11px] font-bold flex-shrink-0">3</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-gray-700 break-words">{a.step3}</p>
                        <p className="text-[10px] text-gray-400 font-mono mt-0.5 break-all">public/models/labels.json</p>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <button onClick={loadModel} className="w-full py-3 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-xl font-medium active:scale-[0.97] transition-transform flex items-center justify-center gap-2 px-4">
                      <RefreshCw className="w-4 h-4 flex-shrink-0" /><span className="truncate">{a.redetectModel}</span>
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <>
          <div className="flex-1 px-4 pb-4 overflow-hidden">
            {!image ? (
              <div className="h-full flex flex-col items-center justify-center">
                <div className="text-center mb-6">
                  <div className="w-16 h-16 mx-auto mb-3 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-full flex items-center justify-center">
                    <ScanLine className="w-8 h-8 text-white" />
                  </div>
                  <h3 className="text-base font-bold text-gray-800 mb-1">{a.photoDetect}</h3>
                  <p className="text-xs text-gray-500">{a.photoDetectDesc}</p>
                </div>

                <div className="w-full max-w-xs space-y-3">
                  <button
                    onClick={() => void takePhotoViaNativeOrFile(cameraInputRef)}
                    className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white py-3.5 rounded-2xl active:scale-[0.97] transition-transform shadow-lg shadow-emerald-200/60"
                  >
                    <Camera className="w-5 h-5" /><span className="font-medium">{a.takePhoto}</span>
                  </button>
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="w-full flex items-center justify-center gap-2 bg-white text-emerald-700 py-3.5 rounded-2xl active:scale-[0.97] transition-transform shadow-lg shadow-gray-200/60"
                  >
                    <ImageIcon className="w-5 h-5" /><span className="font-medium">{t.camera.chooseFromAlbum}</span>
                  </button>
                  <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={onCameraFile} className="hidden" />
                  <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="hidden" />
                </div>
              </div>
            ) : (
              /* 检测结果区域 */
              <div className="mt-3 space-y-3">
                {/* ═══ Cloud-only: 对话式分析界面 ═══ */}
                {cloudOnlyMode ? (
                  <div className="space-y-3">
                    {/* 用户发送的图片 — 普通右侧气泡 */}
                    <div className="flex justify-end">
                      <div className={`max-w-[85%] rounded-2xl px-1.5 py-1.5 bg-emerald-500 ${isRTL ? 'rounded-bl-md' : 'rounded-br-md'}`}>
                        <img src={image} alt="" className="max-w-48 max-h-48 w-auto h-auto rounded-xl block" />
                      </div>
                    </div>

                    {/* AI正在分析 */}
                    {deepAnalyzing && (
                      <div className="flex justify-start">
                        <div className={`bg-gray-100 rounded-2xl ${isRTL ? 'rounded-br-md' : 'rounded-bl-md'} px-4 py-3 max-w-[85%]`}>
                          <div className="flex items-center gap-2 mb-2">
                            <Sparkles className="w-4 h-4 text-emerald-500 animate-pulse" />
                            <span className="text-xs text-gray-600 font-medium">{a.deepAnalyzing}</span>
                          </div>
                          {queueWaitSeconds > 0 && (
                            <p className="text-[10px] text-gray-500 mb-2">
                              {(a.serverBusyRetry || 'Server is busy. Queuing…').replace(/\{seconds\}/g, String(queueWaitSeconds))}
                            </p>
                          )}
                          <div className="w-full bg-gray-200 rounded-full h-1 overflow-hidden">
                            <div className="bg-emerald-500 h-1 rounded-full" style={{ width: '60%', animation: 'loading 2s ease-in-out infinite' }} />
                          </div>
                        </div>
                      </div>
                    )}

                    {/* AI分析出错 */}
                    {deepError && (
                      <div className="flex justify-start">
                        <div className={`bg-red-50 rounded-2xl ${isRTL ? 'rounded-br-md' : 'rounded-bl-md'} px-4 py-3 max-w-[85%]`}>
                          <div className="flex items-center gap-2 mb-1">
                            <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                            <span className="text-xs text-red-600 font-medium">{a.deepAnalysisError}</span>
                          </div>
                          <p className="text-[10px] text-red-400 mb-2">{deepError}</p>
                          {needsReverify ? (
                            <button
                              type="button"
                              onClick={goToReverifyLogin}
                              className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white py-2 rounded-xl active:scale-[0.97] transition-transform text-xs font-medium"
                            >
                              {a.aiLoginRequired}
                            </button>
                          ) : (
                          <button
                            onClick={() => { autoTriggeredRef.current = false; handleCloudAnalysis(); }}
                            className="w-full flex items-center justify-center gap-2 bg-red-100 text-red-700 py-2 rounded-xl active:scale-[0.97] transition-transform text-xs font-medium"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />{a.deepAnalysisRetry}
                          </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* AI分��结果 — 与普通AI消息统一风格 */}
                    {deepAnalysisResult && (
                      <div className="flex justify-start">
                        <div 
                          className={`max-w-[85%] rounded-2xl px-3 py-2 bg-gray-100 text-gray-700 ${isRTL ? 'rounded-br-md' : 'rounded-bl-md'} cursor-pointer active:opacity-70`}
                          onClick={() => handleAITextClick(deepAnalysisResult.analysis)}
                        >
                          <div className="leading-relaxed" style={{ fontSize: 'clamp(13px, 3.5vw, 15px)' }}>{renderMarkdown(deepAnalysisResult.analysis)}</div>
                        </div>
                      </div>
                    )}

                    {/* 追问对话消息 */}
                    {chatMessages.map((msg, idx) => {
                      const isVoice = !!msg.voiceDuration;
                      const isPlaying = playingVoiceIdx === idx;
                      return (
                      <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div 
                          className={`max-w-[85%] rounded-2xl px-3 py-2 ${
                            msg.role === 'user'
                              ? `bg-emerald-500 text-white ${isRTL ? 'rounded-bl-md' : 'rounded-br-md'}`
                              : `bg-gray-100 text-gray-700 ${isRTL ? 'rounded-br-md' : 'rounded-bl-md'} cursor-pointer active:opacity-70`
                          }`}
                          onClick={() => msg.role === 'ai' && !msg.text.startsWith('⚠️') && handleAITextClick(msg.text)}
                        >
                          {msg.image && (
                            <img src={msg.image} alt="" className="max-w-44 max-h-48 w-auto h-auto rounded-xl mb-1" />
                          )}
                          {isVoice ? (
                            <button
                              className="flex items-center gap-2 min-w-[80px] w-full"
                              onClick={(e) => { e.stopPropagation(); toggleVoicePlay(idx, msg.voiceDuration!); }}
                            >
                              {isPlaying
                                ? <Pause className="w-3.5 h-3.5 flex-shrink-0" />
                                : <Play className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" />
                              }
                              <div className="flex items-end gap-[2px] h-4">
                                {[1.5, 3, 2, 3.5, 1.5, 3, 2].map((h, i) => (
                                  <div
                                    key={i}
                                    className={`w-[3px] rounded-full ${msg.role === 'user' ? 'bg-white/80' : 'bg-gray-500'}`}
                                    style={isPlaying ? {
                                      height: `${h * 4}px`,
                                      animation: `voiceWave 0.4s ease-in-out ${i * 0.07}s infinite alternate`,
                                    } : {
                                      height: `${h * 4}px`,
                                    }}
                                  />
                                ))}
                              </div>
                              <span className="text-[10px] font-semibold flex-shrink-0">{msg.voiceDuration}"</span>
                            </button>
                          ) : msg.role === 'ai' ? (
                            <div className="leading-relaxed" style={{ fontSize: 'clamp(13px, 3.5vw, 15px)' }}>{renderMarkdown(msg.text)}</div>
                          ) : msg.text ? (
                            <p className="leading-relaxed" style={{ fontSize: 'clamp(13px, 3.5vw, 15px)' }}>{msg.text}</p>
                          ) : null}
                        </div>
                      </div>
                      );
                    })}
                    {chatReplying && (
                      <div className="flex justify-start">
                        <div className={`bg-gray-100 rounded-2xl ${isRTL ? 'rounded-br-md' : 'rounded-bl-md'} px-3 py-2 flex items-center gap-1.5`}>
                          <Loader className="w-3 h-3 text-emerald-500 animate-spin" />
                          <span className="text-[10px] text-gray-400">{a.aiReplying}</span>
                        </div>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                ) : (
                  <>
                {/* 非云端模式: 图片预览 — 仅在未开始分析时显示 */}
                {!detecting && !deepAnalyzing && !done && !deepAnalysisResult && !deepError && (
                <div className="flex justify-center">
                  <div className="relative w-44 h-44 rounded-2xl overflow-hidden shadow bg-gray-100 flex-shrink-0">
                    {done && results.length > 0 ? (
                      <canvas ref={canvasRef} className="w-full h-full object-cover block" />
                    ) : (
                      <>
                        <img src={image} alt="" className="w-full h-full object-cover block" />
                        {detecting && (
                          <div className="absolute inset-0 bg-black/30 flex flex-col items-center justify-center gap-2">
                            <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          </div>
                        )}
                      </>
                    )}
                    <button onClick={reset} className={`absolute top-1.5 w-6 h-6 bg-black/50 text-white rounded-full flex items-center justify-center active:scale-90 transition-transform ${isRTL ? 'left-1.5' : 'right-1.5'}`}>
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                )}
                  </>
                )}

                {/* 检测结果列表 */}
                {done && results.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <h3 className="text-sm font-bold text-gray-800 truncate min-w-0 flex-1">{a.detected} {results.length} {a.targets}</h3>
                      <button onClick={reset} className="flex items-center gap-1 text-xs text-emerald-600 font-medium flex-shrink-0 whitespace-nowrap">
                        <RefreshCw className="w-3 h-3 flex-shrink-0" />{a.redetect}
                      </button>
                    </div>
                    {results.map((det, i) => {
                      const colors = ['bg-emerald-100 text-emerald-700', 'bg-amber-100 text-amber-700', 'bg-red-100 text-red-700', 'bg-blue-100 text-blue-700', 'bg-violet-100 text-violet-700', 'bg-pink-100 text-pink-700'];
                      return (
                        <div key={i} className="bg-white rounded-xl shadow px-3 py-2.5 flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0 ${colors[i % colors.length]}`}>
                            {i + 1}
                          </div>
                          <span className="font-bold text-gray-800 text-sm flex-1 truncate">{det.className}</span>
                          <span className="text-sm font-bold text-emerald-600 flex-shrink-0">{(det.score * 100).toFixed(1)}%</span>
                        </div>
                      );
                    })}

                  </div>
                )}

                {/* 无结果 */}
                {done && results.length === 0 && !cloudOnlyMode && (
                  <div className="bg-white rounded-2xl p-5 shadow text-center">
                    <p className="text-sm text-gray-600">{a.noTarget}</p>
                    <p className="text-xs text-gray-400 mt-1">{a.tryClearer}</p>
                  </div>
                )}

                {/* Deep Analysis — 按钮已移至底部，此处仅展示 loading/error/result */}
                {done && results.length > 0 && (deepAnalyzing || deepError || deepAnalysisResult) && (
                  <div className="space-y-2 pt-1">
                    {/* Loading state */}
                    {deepAnalyzing && (
                      <div className="bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-5">
                        <div className="flex flex-col items-center gap-3">
                          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center">
                            <Sparkles className="w-6 h-6 text-white animate-pulse" />
                          </div>
                          <div className="text-center">
                            <p className="text-sm text-emerald-700 font-medium">{a.deepAnalyzing}</p>
                            {queueWaitSeconds > 0 && (
                              <p className="text-xs text-emerald-600/80 mt-1">
                                {(a.serverBusyRetry || 'Server is busy. Queuing…').replace(/\{seconds\}/g, String(queueWaitSeconds))}
                              </p>
                            )}
                          </div>
                          <div className="w-full bg-emerald-200 rounded-full h-1 overflow-hidden">
                            <div className="bg-emerald-600 h-1 rounded-full animate-[loading_2s_ease-in-out_infinite]" style={{ width: '60%', animation: 'loading 2s ease-in-out infinite' }} />
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Error state */}
                    {deepError && (
                      <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3">
                        <div className="flex items-center gap-2 mb-2">
                          <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
                          <span className="text-xs text-red-600 font-medium">{a.deepAnalysisError}</span>
                        </div>
                        <p className="text-[10px] text-red-400 mb-2">{deepError}</p>
                        {needsReverify ? (
                          <button
                            type="button"
                            onClick={goToReverifyLogin}
                            className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white py-2.5 rounded-xl active:scale-[0.97] transition-transform text-xs font-medium"
                          >
                            {a.aiLoginRequired}
                          </button>
                        ) : (
                        <button
                          type="button"
                          onClick={() => handleDeepAnalysis()}
                          className="w-full flex items-center justify-center gap-2 bg-red-100 text-red-700 py-2.5 rounded-xl active:scale-[0.97] transition-transform text-xs font-medium"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />{a.deepAnalysisRetry}
                        </button>
                        )}
                      </div>
                    )}

                    {/* Analysis Result */}
                    {deepAnalysisResult && (
                      <div className="bg-white rounded-2xl shadow-lg border border-emerald-100 overflow-hidden">
                        {/* Header */}
                        <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 px-4 py-3 flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <Sparkles className="w-4 h-4 text-white flex-shrink-0" />
                            <span className="text-sm text-white font-medium truncate">{a.deepAnalysisResult}</span>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            {/* Copy button */}
                            <button
                              onClick={handleCopyReport}
                              className="flex items-center gap-1 text-[10px] text-white/80 hover:text-white bg-white/15 px-2 py-1 rounded-lg active:scale-95 transition-all"
                            >
                              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                              {copied ? a.copied : a.copyReport}
                            </button>
                            {/* Collapse/Expand */}
                            <button
                              onClick={() => setDeepExpanded(!deepExpanded)}
                              className="text-white/80 hover:text-white p-1 rounded-lg active:scale-95 transition-all"
                            >
                              {deepExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                            </button>
                          </div>
                        </div>

                        {/* Body */}
                        {deepExpanded && (
                          <div className="px-4 py-3 max-h-[400px] overflow-y-auto">
                            {renderMarkdown(deepAnalysisResult.analysis)}
                          </div>
                        )}

                        {/* Follow-up chat messages */}
                        {chatMessages.length > 0 && (
                          <div className="px-4 py-2 border-t border-gray-100 space-y-2 max-h-[300px] overflow-y-auto">
                            {chatMessages.map((msg, idx) => {
                              const isVoice = !!msg.voiceDuration;
                              const isPlaying = playingVoiceIdx === idx;
                              return (
                              <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                <div 
                                  className={`max-w-[85%] rounded-2xl px-3 py-2 ${
                                    msg.role === 'user'
                                      ? `bg-emerald-500 text-white ${isRTL ? 'rounded-bl-md' : 'rounded-br-md'}`
                                      : `bg-gray-100 text-gray-700 ${isRTL ? 'rounded-br-md' : 'rounded-bl-md'} cursor-pointer active:opacity-70`
                                  }`}
                                  onClick={() => msg.role === 'ai' && !msg.text.startsWith('⚠️') && handleAITextClick(msg.text)}
                                >
                                  {msg.image && (
                                    <img src={msg.image} alt="" className="max-w-44 max-h-48 w-auto h-auto rounded-xl mb-1" />
                                  )}
                                  {isVoice ? (
                                    <button
                                      className="flex items-center gap-2 min-w-[80px] w-full"
                                      onClick={(e) => { e.stopPropagation(); toggleVoicePlay(idx, msg.voiceDuration!); }}
                                    >
                                      {isPlaying
                                        ? <Pause className="w-3.5 h-3.5 flex-shrink-0" />
                                        : <Play className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" />
                                      }
                                      <div className="flex items-end gap-[2px] h-4">
                                        {[1.5, 3, 2, 3.5, 1.5, 3, 2].map((h, i) => (
                                          <div
                                            key={i}
                                            className={`w-[3px] rounded-full ${msg.role === 'user' ? 'bg-white/80' : 'bg-gray-500'}`}
                                            style={isPlaying ? {
                                              height: `${h * 4}px`,
                                              animation: `voiceWave 0.4s ease-in-out ${i * 0.07}s infinite alternate`,
                                            } : {
                                              height: `${h * 4}px`,
                                            }}
                                          />
                                        ))}
                                      </div>
                                      <span className="text-[10px] font-semibold flex-shrink-0">{msg.voiceDuration}"</span>
                                    </button>
                                  ) : msg.role === 'ai' ? (
                                    <div className="leading-relaxed" style={{ fontSize: 'clamp(13px, 3.5vw, 15px)' }}>{renderMarkdown(msg.text)}</div>
                                  ) : msg.text ? (
                                    <p className="leading-relaxed" style={{ fontSize: 'clamp(13px, 3.5vw, 15px)' }}>{msg.text}</p>
                                  ) : null}
                                </div>
                              </div>
                              );
                            })}
                            {chatReplying && (
                              <div className="flex justify-start">
                                <div className={`bg-gray-100 rounded-2xl ${isRTL ? 'rounded-br-md' : 'rounded-bl-md'} px-3 py-2 flex items-center gap-1.5`}>
                                  <Loader className="w-3 h-3 text-emerald-500 animate-spin" />
                                  <span className="text-[10px] text-gray-400">{a.aiReplying}</span>
                                </div>
                              </div>
                            )}
                            <div ref={chatEndRef} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          </>
        )}
      </div>

    </SecondaryView>
  );
}
export default AIAssistantPage;
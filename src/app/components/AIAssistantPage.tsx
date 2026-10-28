import { SecondaryView } from "./SecondaryView";
import { useLanguage } from "../hooks/useLanguage";
import { useState, useRef, useEffect, useCallback, useMemo, type RefObject } from "react";
import { Camera, Loader, X, ScanLine, RefreshCw, AlertTriangle, FolderOpen, Play, Pause, Sparkles, Copy, Check, ChevronDown, ChevronUp, Send, Mic, PenLine, Image as ImageIcon, Volume2, VolumeX } from "lucide-react";
import { TaprootAgroDetector, Detection } from "../utils/taprootAgroDetector";
import { useConfigContext } from "../hooks/ConfigProvider";
import { cloudAIService, getCloudAIHealth } from "../services/CloudAIService";
import { COMPRESS_PRESETS, compressImageBase64, compressImageFile } from "../utils/imageCompressor";
import { useKeyboardHeight } from "../hooks/useKeyboardHeight";
import { isNative, bridge } from "../utils/capacitor-bridge";
import { useNavigate } from "react-router";
import { MockModeBanner } from "./MockModeBanner";
import { isProductionBuild } from "../utils/productionGuard";
import { AIMarkdown } from "./ai/AIMarkdown";
import { AIChatMessageList } from "./ai/AIChatMessageList";
import { VoiceHoldButton } from "./ai/VoiceHoldButton";
import { useCloudAIConversation } from "../hooks/useCloudAIConversation";
import { useTtsReader } from "../hooks/useTtsReader";
import { useVoiceHoldRecorder } from "../hooks/useVoiceHoldRecorder";

const AI_PENDING_PHOTO_KEY = '__taproot_ai_pending_photo__';
let aiPendingPhotoMem: string | null = null;

function stashAiPendingPhoto(dataUrl: string) {
  aiPendingPhotoMem = dataUrl;
  try {
    sessionStorage.setItem(AI_PENDING_PHOTO_KEY, dataUrl);
  } catch {
    /* quota / private mode */
  }
}

function peekAiPendingPhoto(): string | null {
  if (aiPendingPhotoMem) return aiPendingPhotoMem;
  try {
    return sessionStorage.getItem(AI_PENDING_PHOTO_KEY);
  } catch {
    return null;
  }
}

function clearAiPendingPhoto() {
  aiPendingPhotoMem = null;
  try {
    sessionStorage.removeItem(AI_PENDING_PHOTO_KEY);
  } catch {
    /* ignore */
  }
}

interface AIAssistantPageProps {
  onClose: () => void;
}

type Status = 'idle' | 'loading' | 'ready' | 'no-model' | 'error' | 'cloud-only' | 'ai-disabled';

export function AIAssistantPage({ onClose }: AIAssistantPageProps) {
  const { t, isRTL, language } = useLanguage();
  const { config } = useConfigContext();
  const a = t.ai;
  const navigate = useNavigate();
  const { isKeyboardOpen } = useKeyboardHeight();

  // Cloud-only mode: when cloud AI is enabled AND device is online, skip local model
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const cloudAiEnabled = config.cloudAIConfig?.enabled === true;
  const enableLocalModel = config.aiModelConfig?.enableLocalModel === true;
  const cloudOnlyMode = cloudAiEnabled && isOnline;
  const cloudAiMode = useMemo(
    () => cloudAIService.mode,
    [config.cloudAIConfig, config.backendProxyConfig],
  );

  const { ttsEnabled, ttsSpeaking, ttsPaused, speakText, stopTTS, toggleTTS, togglePauseResume, readAloud } =
    useTtsReader(language);
  const {
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
    dailyUsage,
    isUnlimited,
    runDeepAnalysis,
    showLocalAnalysis,
    appendAiMessage,
    sendChatImage,
    submitFollowUpText,
    sendVoiceAudio,
    resetConversation,
  } = useCloudAIConversation({ a, language, cloudAIConfig: config.cloudAIConfig });

  // 仅 Gemini 走"音频直发 → 多模态识别理解"；其他提供商（Qwen 等）维持原有的本地 STT → 文字流程。
  // 以 Edge /health 返回的 provider（AI_PROVIDER secret）为准；探测完成前或失败时按「内容管理 → AI 模型」的 modelId / providerName 判断。
  const [edgeProvider, setEdgeProvider] = useState<string | null>(null);
  useEffect(() => {
    if (!cloudAiEnabled || !sessionReady || cloudAiMode !== 'backend') return;
    let cancelled = false;
    void getCloudAIHealth().then((h) => {
      if (!cancelled && h) setEdgeProvider(h.provider);
    });
    return () => {
      cancelled = true;
    };
  }, [cloudAiEnabled, sessionReady, cloudAiMode]);
  const modelIdLower = (config.cloudAIConfig?.modelId || '').toLowerCase();
  const providerNameLower = (config.cloudAIConfig?.providerName || '').toLowerCase();
  const useDirectAudio = edgeProvider
    ? edgeProvider === 'gemini'
    : modelIdLower.includes('gemini') || providerNameLower.includes('gemini');

  const recorder = useVoiceHoldRecorder({
    language,
    useDirectAudio,
    canStart: !!deepAnalysisResult && !chatReplying && !deepAnalyzing,
    sttNotSupported: a.sttNotSupported,
    onStart: stopTTS,
    onAudio: sendVoiceAudio,
    onTranscript: submitFollowUpText,
    onNoSpeech: () => appendAiMessage(`⚠️ ${a.sttNoResult}`),
    onSttFailed: () => appendAiMessage(`⚠️ ${a.sttFailed}`),
  });

  // 系统相机 input ref
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const [image, setImage] = useState<string | null>(() => peekAiPendingPhoto());
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState(0);
  const [detecting, setDetecting] = useState(false);
  const [results, setResults] = useState<Detection[]>([]);
  const [done, setDone] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const [deepExpanded, setDeepExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

  // Follow-up chat input
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

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
      const msg = chatMessagesRef.current[idx];
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
  }, [playingVoiceIdx, stopCurrentVoice]);

  // Input mode: default voice, user can switch to text via pen icon
  const [inputMode, setInputMode] = useState<'voice' | 'text'>('voice');

  // 语音录制是否可用（Fix 4: 只有 deepAnalysisResult 存在且 AI 没在回复时才可录音）
  const voiceEnabled = !!deepAnalysisResult && !chatReplying && !deepAnalyzing && !isLocalAIResult && cloudAiEnabled;

  // Camera menu state (for chat bar)
  const [showCamMenu, setShowCamMenu] = useState(false);
  const chatFileRef = useRef<HTMLInputElement>(null);
  const chatCameraRef = useRef<HTMLInputElement>(null);

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

  // 系统相机拍照 — Native 优先走 bridge.camera；取消不打开 file input。
  // 拍照结果写入 sessionStorage，避免 Android 相机页杀掉 WebView 后丢图。
  const applyPhotoDataUrl = useCallback((dataUrl: string) => {
    stashAiPendingPhoto(dataUrl);
    setImage(dataUrl);
    setResults([]);
    setDone(false);
  }, []);

  const captureNativeOrClickFile = useCallback(async (
    fileInputRef: RefObject<HTMLInputElement | null>,
    onDataUrl: (dataUrl: string) => void,
  ) => {
    if (isNative()) {
      try {
        const photo = await bridge.camera.takePhoto({
          source: 'camera',
          quality: 80,
          width: 1920,
        });
        if (!photo) return;
        const dataUrl = await bridge.camera.photoToDataUrl(photo);
        if (dataUrl) {
          const compressed = await compressImageBase64(dataUrl, COMPRESS_PRESETS.ai);
          onDataUrl(compressed);
          return;
        }
      } catch {
        /* fall through to file input */
      }
    }
    fileInputRef.current?.click();
  }, []);

  const onCameraFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      applyPhotoDataUrl(await compressImageFile(f, COMPRESS_PRESETS.ai));
    } catch {
      /* ignore */
    }
    if (cameraInputRef.current) cameraInputRef.current.value = '';
  };

  // 选图 — 拍照/相册先压到 AI 预设，减轻内存与 sessionStorage 压力
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      applyPhotoDataUrl(await compressImageFile(f, COMPRESS_PRESETS.ai));
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
      imgSrc = await compressImageFile(f, COMPRESS_PRESETS.ai);
    } catch {
      if (chatCameraRef.current) chatCameraRef.current.value = '';
      return;
    }
    if (chatCameraRef.current) chatCameraRef.current.value = '';
    await sendChatImage(imgSrc);
  };

  const onChatFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setShowCamMenu(false);
    try {
      const imgSrc = await compressImageFile(f, COMPRESS_PRESETS.ai);
      sendChatImage(imgSrc);
    } catch {
      /* ignore */
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
    
    showLocalAnalysis(analysis);
    setDeepExpanded(true);

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
    resetConversation();
    clearAiPendingPhoto();
    setImage(null);
    setResults([]);
    setDone(false);
    setCopied(false);
    setChatInput('');
    setPlayingVoiceIdx(null);
    stopCurrentVoice();
    recorder.reset();
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

  /** 云端首诊网络失败时的本地兜底；返回要展示的错误文案，已展示本地结果时返回 null。 */
  const fallbackToLocalAnalysis = async (imageSrc: string, isCloudOnly: boolean): Promise<string | null> => {
    if (!isCloudOnly && results.length > 0 && enableLocalModel) {
      // Scenario 3a: Network error with cloud AI enabled + local results already available
      // Fallback to local AI with network warning
      generateLocalAnalysis(results, true);
      return null;
    }
    if (isCloudOnly && enableLocalModel) {
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
        img.src = imageSrc;
        await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; });
        const dets = await detectorRef.current!.detect(img);
        setResults(dets);
        setDone(true);
        pendingDrawRef.current = { img, dets };
        if (dets.length > 0) {
          generateLocalAnalysis(dets, true);
          return null;
        }
        return a.networkErrorHint;
      } catch {
        // Local detection also failed
        return a.networkErrorHint;
      }
    }
    if (isCloudOnly) return a.offlineCloudOnlyNoLocal;
    // Network error but no local model available
    return a.networkErrorHint;
  };

  // Deep Analysis handler (unified for both local+cloud and cloud-only modes)
  const handleDeepAnalysis = async (forceCloudOnly = false) => {
    if (!image) return;
    // In cloud-only mode or forced cloud-only, we don't require local detection results
    const isCloudOnly = cloudOnlyMode || forceCloudOnly;
    if (!isCloudOnly && results.length === 0) return;
    setDeepExpanded(true);
    const result = await runDeepAnalysis({
      image,
      detections: isCloudOnly ? [] : results.map((d) => ({ className: d.className, score: d.score })),
      onTransportError: () => fallbackToLocalAnalysis(image, isCloudOnly),
    });
    if (!result) return;
    clearAiPendingPhoto();
    if (isCloudOnly) setDone(true);
    // Auto-read the initial analysis
    speakText(result.analysis);
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

  const handleChatSend = async () => {
    const msg = chatInput.trim();
    if (!msg || !deepAnalysisResult || chatReplying || deepAnalyzing) return;
    setChatInput('');
    if (chatInputRef.current) {
      chatInputRef.current.style.height = '48px';
    }
    await submitFollowUpText(msg);
  };

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
          {recorder.sttError && (
            <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">{recorder.sttError}</p>
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
            <VoiceHoldButton
              recorder={recorder}
              enabled={voiceEnabled}
              idleLabel={voiceEnabled ? a.holdToSpeak : (deepAnalyzing ? (a.deepAnalyzing || 'Analyzing...') : (chatReplying ? (a.aiReplying || 'AI replying...') : a.holdToSpeak))}
              micDeniedLabel={a.micDenied || 'Microphone permission denied'}
              releaseLabel={a.releaseToSend}
            />
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
                  onClick={() => { setShowCamMenu(false); void captureNativeOrClickFile(chatCameraRef, (url) => void sendChatImage(url)); }}
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

        {isProductionBuild() && cloudAiEnabled && cloudAiMode === "mock" && (
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
                    onClick={() => void captureNativeOrClickFile(cameraInputRef, applyPhotoDataUrl)}
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
                          ) : deepErrorNoRetry ? null : (
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
                          onClick={() => readAloud(deepAnalysisResult.analysis)}
                        >
                          <div className="leading-relaxed" style={{ fontSize: 'clamp(13px, 3.5vw, 15px)' }}><AIMarkdown text={deepAnalysisResult.analysis} /></div>
                        </div>
                      </div>
                    )}

                    {/* 追问对话消息 */}
                    <AIChatMessageList
                      messages={chatMessages}
                      playingVoiceIdx={playingVoiceIdx}
                      onToggleVoice={toggleVoicePlay}
                      onSpeak={readAloud}
                      isRTL={isRTL}
                    />
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
                        ) : deepErrorNoRetry ? null : (
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
                            <AIMarkdown text={deepAnalysisResult.analysis} />
                          </div>
                        )}

                        {/* Follow-up chat messages */}
                        {chatMessages.length > 0 && (
                          <div className="px-4 py-2 border-t border-gray-100 space-y-2 max-h-[300px] overflow-y-auto">
                            <AIChatMessageList
                              messages={chatMessages}
                              playingVoiceIdx={playingVoiceIdx}
                              onToggleVoice={toggleVoicePlay}
                              onSpeak={readAloud}
                              isRTL={isRTL}
                            />
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
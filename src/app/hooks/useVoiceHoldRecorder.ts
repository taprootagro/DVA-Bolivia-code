import { useCallback, useEffect, useRef, useState } from "react";
import type { Language } from "./useLanguage";
import { isNative, speechRecognition, type WebSpeechHoldSession } from "../utils/capacitor-bridge";
import { isAppPermissionEnabled } from "../utils/appPermissions";
import { languageToSpeechTag } from "../utils/speechLocale";

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

export type VoiceHoldRecorderOptions = {
  language: Language;
  /** true：MediaRecorder 录原始音频交给 onAudio（Gemini 音频直发）；false：本地 STT 转写后交给 onTranscript。 */
  useDirectAudio: boolean;
  canStart: boolean;
  sttNotSupported: string;
  onStart: () => void;
  onAudio: (blob: Blob, durationSec: number) => Promise<void>;
  onTranscript: (text: string) => Promise<void>;
  /** 没录到声音 / 没识别出文字 */
  onNoSpeech: () => void;
  onSttFailed: () => void;
};

/**
 * 按住说话：Web Speech / 原生 STT 或 MediaRecorder 直录；拖出按钮取消、59s 自动结束、退出时释放麦克风。
 * 回调与开关在调用时读取最近一次 render 传入的 options。
 */
export function useVoiceHoldRecorder(options: VoiceHoldRecorderOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

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

  // Gemini 音频直发路径：录制原始音频 Blob，交给 onAudio。
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
    const { language, onAudio, onTranscript, onNoSpeech, onSttFailed } = optionsRef.current;
    const elapsedMs = Math.max(0, performance.now() - voiceHoldStartedAtRef.current);
    // 真实按住秒数（用于气泡展示）；逻辑最短时长用 elapsedMs，不用 1s 步进定时器
    const durationSec = Math.max(1, Math.round(elapsedMs / 1000));
    const wasCancelled = voiceCancelPendingRef.current;
    const wasDirectAudio = voiceUseDirectAudioRef.current;
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
          onNoSpeech();
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
        onNoSpeech();
        voiceTimeRef.current = 0;
        setVoiceTime(0);
        return;
      }

      try {
        await onAudio(blob, durationSec);
      } finally {
        voiceTimeRef.current = 0;
        setVoiceTime(0);
        voiceUseDirectAudioRef.current = false;
      }
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
        onNoSpeech();
        voiceTimeRef.current = 0;
        setVoiceTime(0);
        return;
      }

      await onTranscript(text);
    } catch (e) {
      console.warn('[AI Voice STT]', e);
      onSttFailed();
    } finally {
      voiceUseDirectAudioRef.current = false;
      voiceTimeRef.current = 0;
      setVoiceTime(0);
    }
  }, [releaseMediaStream, stopRecorderAndGetBlob]);

  const handleVoiceRecordStart = useCallback(() => {
    if (isVoiceRecordingRef.current) return;
    const { canStart, useDirectAudio, language, sttNotSupported, onStart } = optionsRef.current;
    if (!canStart) return;
    if (!isAppPermissionEnabled('microphone')) {
      setMicPermissionDenied(true);
      setTimeout(() => setMicPermissionDenied(false), 3000);
      return;
    }
    onStart();
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

    // ═══ Gemini 音频直发：MediaRecorder 录制 webm/opus，松手后交给 onAudio ═══
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
        setSttError(sttNotSupported);
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
        void handleVoiceRecordEnd();
      }
    }, 1000);
  }, [handleVoiceRecordEnd, releaseMediaStream]);

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

  /** 页面「重新拍照」：只复位计时与按住标记，不动麦克风与识别会话。 */
  const reset = useCallback(() => {
    isVoiceRecordingRef.current = false;
    voiceTimeRef.current = 0;
    if (voiceTimerRef.current) { clearInterval(voiceTimerRef.current); voiceTimerRef.current = null; }
  }, []);

  return {
    isRecording: isVoiceRecording,
    voiceTime,
    cancelPending: voiceCancelPending,
    micPermissionDenied,
    sttError,
    isRecordingRef: isVoiceRecordingRef,
    cancelPendingRef: voiceCancelPendingRef,
    setCancelPending: setVoiceCancelPending,
    start: handleVoiceRecordStart,
    end: handleVoiceRecordEndSync,
    cancel: handleVoiceRecordCancel,
    reset,
  };
}

export type VoiceHoldRecorder = ReturnType<typeof useVoiceHoldRecorder>;

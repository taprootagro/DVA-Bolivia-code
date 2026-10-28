import { useCallback, useEffect, useRef, useState } from "react";
import type { Language } from "./useLanguage";
import { isNative, textToSpeech } from "../utils/capacitor-bridge";
import { languageToSpeechTag, speechTagFallbacks, ttsRateForLanguage } from "../utils/speechLocale";
import { storageGet, storageSet } from "../utils/safeStorage";

const TTS_PREF_KEY = 'ai_tts_enabled';

// Strip markdown for cleaner TTS reading
function stripMarkdown(md: string): string {
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
}

/** AI 回复朗读：静音开关持久化到 safeStorage（默认开），按 UI 语言分句串播，可暂停/恢复。 */
export function useTtsReader(language: Language) {
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

    if (ttsAbortRef.current) ttsAbortRef.current.abort();
    const controller = new AbortController();
    ttsAbortRef.current = controller;
    setTtsSpeaking(true);
    setTtsPaused(false);

    const lang = languageToSpeechTag(language);
    const nativeDelayMs = isNative() ? 350 : 0;

    const run = async () => {
      await textToSpeech.stop().catch(() => { /* ignore */ });
      if (controller.signal.aborted) return;
      if (nativeDelayMs) {
        await new Promise((r) => setTimeout(r, nativeDelayMs));
      }
      if (controller.signal.aborted) return;
      await textToSpeech.speakQueue(clean, {
        lang,
        langFallbacks: speechTagFallbacks(language),
        rate: ttsRateForLanguage(language),
        pitch: 1.0,
        signal: controller.signal,
      });
    };

    run().finally(() => {
      if (ttsAbortRef.current === controller) {
        ttsAbortRef.current = null;
        setTtsSpeaking(false);
        setTtsPaused(false);
      }
    });
  }, [ttsEnabled, language]);

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
  const readAloud = useCallback((text: string) => {
    stopTTS();
    if (!ttsEnabled) setTtsEnabled(true);
    speakText(text, true);
  }, [ttsEnabled, speakText, stopTTS]);

  return { ttsEnabled, ttsSpeaking, ttsPaused, speakText, stopTTS, toggleTTS, togglePauseResume, readAloud };
}

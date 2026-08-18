import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "react-router";
import { type ChatMessage } from "../../../services/ChatProxyService";
import { textToSpeech } from "../../../utils/capacitor-bridge";
import { useLanguage } from "../../../hooks/useLanguage";
import { languageToSpeechTag, speechTagFallbacks, ttsRateForLanguage } from "../../../utils/speechLocale";

// ── TTS 辅助函数 ──────────────────────────────────────────────────────────
// 使用 capacitor-bridge 的 textToSpeech（App 下走原生插件，PWA 下走 speechSynthesis）
// Android WebView 的 speechSynthesis 极不稳定，必须依赖原生 TTS 插件

/** 停止所有 TTS 播放 */
function stopAllTTS(): void {
  textToSpeech.stop().catch(() => { /* ignore */ });
}

export function useVoiceSystem(chatMessages: ChatMessage[], currentUserId: string) {
  const location = useLocation();
  const { language } = useLanguage();

  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(true); // 默认开启朗读（全局控制）
  const playingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 用 ref 跟踪 ttsEnabled 的最新值，避免 speakText 回调频繁重建
  const ttsEnabledRef = useRef(ttsEnabled);
  ttsEnabledRef.current = ttsEnabled;

  // Real audio playback ref
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Helper: stop any currently playing audio
  const stopCurrentAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    if (playingTimerRef.current) {
      clearTimeout(playingTimerRef.current);
      playingTimerRef.current = null;
    }
  }, []);

  // 清理播放定时器
  useEffect(() => {
    return () => {
      stopCurrentAudio();
    };
  }, [stopCurrentAudio]);

  // 离开页面时停止TTS播放
  useEffect(() => {
    if (location.pathname.startsWith('/home/community')) return;
    stopAllTTS();
    if (playingVoiceId) {
      stopCurrentAudio();
      setPlayingVoiceId(null);
    }
  }, [location.pathname, playingVoiceId, stopCurrentAudio]);

  // TTS朗读文字消息（统一管理）— 使用 bridge.textToSpeech 确保 App 下走原生插件
  const speakText = useCallback((text: string, force = false) => {
    if (!force && !ttsEnabledRef.current) return;
    if (!text?.trim()) return;

    stopAllTTS();
    const lang = languageToSpeechTag(language);
    textToSpeech
      .speakQueue(text.trim(), {
        lang,
        langFallbacks: speechTagFallbacks(language),
        rate: ttsRateForLanguage(language),
      })
      .catch(() => { /* bridge 内部已处理 Web 降级 */ });
  }, [language]);

  // 点击文字消息时主动朗读 — useCallback 配合 MessageBubble React.memo
  const handleTextMsgClick = useCallback((text: string) => {
    // 如果当前是关闭状态，自动开启
    if (!ttsEnabledRef.current) {
      setTtsEnabled(true);
    }
    // 强制朗读选中的文字
    speakText(text, true);
  }, [speakText]);

  // 语音播放切换 — 真实音频播放
  const toggleVoicePlay = useCallback((msgId: string, duration: number) => {
    setPlayingVoiceId((prev) => {
      if (prev === msgId) {
        // 暂停当前播放
        stopCurrentAudio();
        return null;
      }

      // 停止之前的播放
      stopCurrentAudio();

      // 查找消息获取音频 URL
      const msg = chatMessages.find(m => m.id === msgId);
      const audioUrl = msg?.audioUrl || msg?.content;

      if (audioUrl && audioUrl !== '' && audioUrl !== '[Voice]') {
        // 真实音频播放
        try {
          const audio = new Audio(audioUrl);
          audioRef.current = audio;

          audio.onended = () => {
            setPlayingVoiceId(null);
            audioRef.current = null;
            if (playingTimerRef.current) {
              clearTimeout(playingTimerRef.current);
              playingTimerRef.current = null;
            }
          };

          audio.onerror = () => {
            console.warn('[Voice] Audio playback error for:', audioUrl);
            setPlayingVoiceId(null);
            audioRef.current = null;
            if (playingTimerRef.current) {
              clearTimeout(playingTimerRef.current);
              playingTimerRef.current = null;
            }
          };

          audio.play().catch(err => {
            console.warn('[Voice] Audio play() rejected:', err);
            setPlayingVoiceId(null);
            audioRef.current = null;
          });

          // Safety timeout — stop after duration + 2s buffer
          playingTimerRef.current = setTimeout(() => {
            if (audioRef.current) {
              audioRef.current.pause();
              audioRef.current = null;
            }
            setPlayingVoiceId(null);
            playingTimerRef.current = null;
          }, ((duration || 5) + 2) * 1000);

        } catch (err) {
          console.warn('[Voice] Failed to create Audio:', err);
          // Fallback to visual-only animation
          playingTimerRef.current = setTimeout(() => {
            setPlayingVoiceId(null);
            playingTimerRef.current = null;
          }, (duration || 5) * 1000);
        }
      } else {
        // 没有音频 URL（历史消息或mock数据）— 纯视觉动画
        playingTimerRef.current = setTimeout(() => {
          setPlayingVoiceId(null);
          playingTimerRef.current = null;
        }, (duration || 5) * 1000);
      }

      return msgId;
    });
  }, [chatMessages, stopCurrentAudio]);

  // 新收到的文字消息自动朗读（仅实时消息，跳过打开线程时拉取的历史）
  const LIVE_TTS_MAX_AGE_MS = 120000;
  const seenMsgIdsRef = useRef<Set<string>>(new Set());
  const seededChannelRef = useRef<string | null>(null);
  useEffect(() => {
    if (chatMessages.length === 0) return;
    const channel = chatMessages[0]?.channelName ?? '';
    const now = Date.now();
    const speakIncoming = (msg: ChatMessage) => {
      if (msg.type !== 'text' || msg.senderId === currentUserId) return;
      if (!ttsEnabledRef.current) return;
      const age = now - (msg.timestamp || now);
      if (Number.isFinite(age) && age >= LIVE_TTS_MAX_AGE_MS) return;
      speakText(msg.content);
    };

    if (seededChannelRef.current !== channel) {
      const switching = seededChannelRef.current !== null;
      seededChannelRef.current = channel;
      const previousIds = seenMsgIdsRef.current;
      seenMsgIdsRef.current = new Set(chatMessages.map((m) => m.id));
      if (switching) return;
      // First fill of an empty thread: speak only brand-new incoming (not a history dump).
      const freshIncoming = chatMessages.filter((m) => {
        if (previousIds.has(m.id)) return false;
        if (m.type !== 'text' || m.senderId === currentUserId) return false;
        const age = now - (m.timestamp || now);
        return !Number.isFinite(age) || age < 15000;
      });
      if (chatMessages.length <= freshIncoming.length) {
        for (const msg of freshIncoming) speakIncoming(msg);
      }
      return;
    }

    for (const msg of chatMessages) {
      if (seenMsgIdsRef.current.has(msg.id)) continue;
      seenMsgIdsRef.current.add(msg.id);
      speakIncoming(msg);
    }
  }, [chatMessages, currentUserId, speakText]);

  const toggleTts = useCallback(() => {
    setTtsEnabled(prev => {
      const newVal = !prev;
      if (!newVal) {
        stopAllTTS();
      }
      return newVal;
    });
  }, []);

  return {
    playingVoiceId,
    ttsEnabled,
    toggleTts,
    toggleVoicePlay,
    handleTextMsgClick,
  };
}
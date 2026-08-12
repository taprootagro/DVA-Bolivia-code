import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Plus, Mic, PenLine, Send, Camera, MicOff, Image as ImageIcon } from "lucide-react";
import { useLanguage } from "../../hooks/useLanguage";
import { useVoiceRecorder } from "./hooks/useVoiceRecorder";
import { bridge, toast } from "../../utils/capacitor-bridge";
import {
  chatImageErrorMessageKey,
  CHAT_IMAGE_LIMITS,
  prepareChatImageFromDataUrl,
  prepareChatImageFromFile,
} from "../../utils/chatImagePrepare";

const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";
const NATIVE_CAMERA_WIDTH = CHAT_IMAGE_LIMITS.maxSize;
const NATIVE_CAMERA_QUALITY = 80;

interface ChatInputBarProps {
  onSendText: (text: string) => void;
  onSendVoice: (duration: number, audioBlob: Blob) => void;
  onSendImage: (base64: string) => void;
  onCall: (type: "audio" | "video") => void;
  isSending: boolean;
  /** When false, hide call buttons (mock / unavailable). Default true. */
  callsEnabled?: boolean;
  /** 紧贴底部关闭条：减内边距、顶部分割线、去掉上投影 */
  adjoinDock?: boolean;
  /** 已屏蔽等：禁止输入与发送 */
  readOnly?: boolean;
}

const WAVE_HEIGHTS = Array.from({ length: 6 }, () => 6 + Math.random() * 10);

export const ChatInputBar = React.memo(function ChatInputBar({
  onSendText,
  onSendVoice,
  onSendImage,
  onCall,
  isSending,
  callsEnabled = true,
  adjoinDock = false,
  readOnly = false,
}: ChatInputBarProps) {
  const { t, isRTL } = useLanguage();

  const [textMessage, setTextMessage] = useState("");
  const [inputMode, setInputMode] = useState<'voice' | 'text'>('voice');
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [showImageSourceSheet, setShowImageSourceSheet] = useState(false);
  const [imageSheetAnim, setImageSheetAnim] = useState<"entering" | "visible" | "leaving">("entering");
  const [isPreparingImage, setIsPreparingImage] = useState(false);

  useEffect(() => {
    if (showImageSourceSheet) {
      setImageSheetAnim("entering");
      requestAnimationFrame(() => setImageSheetAnim("visible"));
    }
  }, [showImageSourceSheet]);

  const closeImageSourceSheet = useCallback(() => {
    setImageSheetAnim("leaving");
    setTimeout(() => setShowImageSourceSheet(false), 200);
  }, []);

  const {
    isRecording,
    recordingTime,
    isRecordingRef,
    isCancelPending,
    isCancelPendingRef,
    micPermissionDenied,
    startRecording,
    stopRecording,
    cancelRecording,
    setCancelPending,
  } = useVoiceRecorder(onSendVoice);

  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const cameraCaptureRef = useRef<HTMLInputElement>(null);
  const albumInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!showPlusMenu) return;

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.plus-menu-container')) {
        setShowPlusMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [showPlusMenu]);

  const handleInputFocus = useCallback((e: React.FocusEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    requestAnimationFrame(() => {
      window.scrollTo(0, 0);
    });
  }, []);

  const handleSendText = useCallback(() => {
    if (readOnly) return;
    if (textMessage.trim() && !isSending) {
      const content = textMessage.trim();
      setTextMessage("");
      if (textInputRef.current) {
        textInputRef.current.style.height = '44px';
      }
      onSendText(content);
    }
  }, [textMessage, isSending, onSendText, readOnly]);

  const showChatImageError = useCallback(
    (code: "unsupported" | "too_large" | "process_failed") => {
      const key = chatImageErrorMessageKey(code);
      const msg =
        t.community?.[key] ||
        (code === "unsupported"
          ? "Only JPG, PNG, and WebP photos are supported."
          : code === "too_large"
            ? "Image too large. Retake or choose another."
            : "Could not process this image. Try again.");
      void toast.show({ text: msg, duration: "short", position: "bottom" });
    },
    [t.community],
  );

  const processAndSendImage = useCallback(
    async (prepare: () => Promise<{ ok: true; dataUrl: string } | { ok: false; code: "unsupported" | "too_large" | "process_failed" }>) => {
      if (readOnly || isPreparingImage || isSending) return;
      setIsPreparingImage(true);
      void toast.show({
        text: t.community?.chatCompressingImage || "Processing image…",
        duration: "short",
        position: "bottom",
      });
      try {
        const result = await prepare();
        if (result.ok) {
          onSendImage(result.dataUrl);
        } else {
          showChatImageError(result.code);
        }
      } finally {
        setIsPreparingImage(false);
      }
    },
    [readOnly, isPreparingImage, isSending, onSendImage, showChatImageError, t.community?.chatCompressingImage],
  );

  const handleImageFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";
      void processAndSendImage(() => prepareChatImageFromFile(file));
    },
    [processAndSendImage],
  );

  const handleNativeCamera = useCallback(async () => {
    closeImageSourceSheet();
    try {
      const photo = await bridge.camera.takePhoto({
        source: "camera",
        width: NATIVE_CAMERA_WIDTH,
        quality: NATIVE_CAMERA_QUALITY,
      });
      if (!photo) return;
      const dataUrl = await bridge.camera.photoToDataUrl(photo);
      if (!dataUrl) {
        showChatImageError("process_failed");
        return;
      }
      await processAndSendImage(() => prepareChatImageFromDataUrl(dataUrl));
    } catch (e) {
      console.warn("[ChatInputBar] native camera failed", e);
      showChatImageError("process_failed");
    }
  }, [closeImageSourceSheet, processAndSendImage, showChatImageError]);

  const handleNativeAlbum = useCallback(async () => {
    closeImageSourceSheet();
    try {
      const photos = await bridge.camera.pickImages({
        quality: NATIVE_CAMERA_QUALITY,
        limit: 1,
      });
      const first = photos[0];
      if (!first) return;
      const dataUrl = await bridge.camera.photoToDataUrl(first);
      if (!dataUrl) {
        showChatImageError("process_failed");
        return;
      }
      await processAndSendImage(() => prepareChatImageFromDataUrl(dataUrl));
    } catch (e) {
      console.warn("[ChatInputBar] native album failed", e);
      showChatImageError("process_failed");
    }
  }, [closeImageSourceSheet, processAndSendImage, showChatImageError]);

  const handlePickCamera = useCallback(() => {
    closeImageSourceSheet();
    if (bridge.isNative()) {
      void handleNativeCamera();
      return;
    }
    setTimeout(() => cameraCaptureRef.current?.click(), 220);
  }, [closeImageSourceSheet, handleNativeCamera]);

  const handlePickAlbum = useCallback(() => {
    closeImageSourceSheet();
    if (bridge.isNative()) {
      void handleNativeAlbum();
      return;
    }
    setTimeout(() => albumInputRef.current?.click(), 220);
  }, [closeImageSourceSheet, handleNativeAlbum]);

  const waveBarStyles = useMemo(() =>
    WAVE_HEIGHTS.map((h, i) => ({
      height: `${h}px`,
      animation: `voiceWave 0.4s ease-in-out ${i * 0.07}s infinite alternate`,
    })),
  []);

  return (
    <div
      className={`px-3 bg-gradient-to-t from-gray-50 to-white flex-shrink-0 relative ${adjoinDock ? "pt-3 pb-2 border-t border-gray-100" : "py-3"} ${readOnly ? "opacity-55 pointer-events-none select-none" : ""}`}
      style={adjoinDock ? undefined : { boxShadow: "0 -1px 8px rgba(0,0,0,0.06)" }}
      aria-disabled={readOnly}
    >
      <input ref={cameraCaptureRef} type="file" accept={IMAGE_ACCEPT} capture="environment" onChange={handleImageFile} className="hidden" />
      <input ref={albumInputRef} type="file" accept={IMAGE_ACCEPT} onChange={handleImageFile} className="hidden" />

      <div className="flex items-end gap-2">
        <div className="relative flex-shrink-0 plus-menu-container">
          <button
            type="button"
            onClick={() => setShowPlusMenu(!showPlusMenu)}
            className={`w-11 h-11 rounded-full flex items-center justify-center active:scale-95 transition-all flex-shrink-0 ${showPlusMenu ? 'bg-emerald-50' : 'bg-gray-100'}`}
          >
            <Plus className={`w-5 h-5 transition-transform ${showPlusMenu ? 'rotate-45 text-emerald-600' : 'text-gray-500'}`} strokeWidth={2.5} />
          </button>
          {showPlusMenu && (
            <div className={`absolute bottom-full mb-2.5 bg-white rounded-2xl py-2 z-20 w-[60px] ${isRTL ? 'right-0' : 'left-0'}`} style={{ boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
              <button type="button" onClick={() => { setInputMode('text'); setShowPlusMenu(false); }} className="w-full px-2 py-2 flex items-center justify-center active:bg-gray-50 transition-colors">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center active:scale-95 transition-transform ${inputMode === 'text' ? 'bg-emerald-600' : 'bg-emerald-500'}`}>
                  <PenLine className="w-[18px] h-[18px] text-white" strokeWidth={2.5} />
                </div>
              </button>
              <div className={`absolute -bottom-1.5 w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[6px] border-t-white ${isRTL ? 'right-4' : 'left-4'}`}></div>
            </div>
          )}
        </div>

        {inputMode === 'text' && (
          <button
            type="button"
            onClick={() => setInputMode('voice')}
            className="w-11 h-11 flex items-center justify-center bg-emerald-50 text-emerald-600 rounded-full active:scale-90 transition-all flex-shrink-0"
          >
            <Mic className="w-[18px] h-[18px]" />
          </button>
        )}

        {inputMode === 'voice' && (
          <div
            className="flex-1 min-w-0 select-none"
            style={{ height: '44px' }}
            onTouchStart={(e) => {
              if (isRecordingRef.current || micPermissionDenied) return;
              const touch = e.touches[0];
              const rect = e.currentTarget.getBoundingClientRect();
              (e.currentTarget as any).__startY = touch?.clientY || 0;
              (e.currentTarget as any).__btnRect = rect;
              startRecording();
            }}
            onTouchMove={(e) => {
              if (!isRecordingRef.current) return;
              const touch = e.touches[0];
              const rect = (e.currentTarget as any).__btnRect as DOMRect;
              if (!rect || !touch) return;
              const isOutside =
                touch.clientX < rect.left - 20 ||
                touch.clientX > rect.right + 20 ||
                touch.clientY < rect.top - 20 ||
                touch.clientY > rect.bottom + 20;
              if (isOutside !== isCancelPendingRef.current) {
                setCancelPending(isOutside);
              }
            }}
            onTouchEnd={() => { stopRecording(); }}
            onTouchCancel={() => cancelRecording()}
            onMouseDown={() => { if (!isRecordingRef.current && !micPermissionDenied) startRecording(); }}
            onMouseUp={() => { stopRecording(); }}
            onMouseLeave={() => {
              if (isRecordingRef.current) {
                setCancelPending(true);
              }
              stopRecording();
            }}
          >
            {micPermissionDenied ? (
              <div className="bg-red-50 rounded-full text-center text-red-500 flex items-center justify-center shadow-sm" style={{ height: '44px', fontSize: 'clamp(11px, 3vw, 13px)' }}>
                <MicOff className="w-4 h-4 inline-block me-1.5 flex-shrink-0" />
                <span className="truncate">{t.ai?.micDenied || 'Microphone permission denied'}</span>
              </div>
            ) : !isRecording ? (
              <div className="bg-emerald-50 rounded-full text-center text-emerald-600 active:bg-emerald-500 active:text-white transition-colors select-none flex items-center justify-center shadow-sm" style={{ height: '44px', fontSize: 'clamp(12px, 3.2vw, 14px)' }}>
                <Mic className="w-4 h-4 inline-block me-1.5 flex-shrink-0" />
                <span className="truncate">{t.ai?.holdToSpeak || 'Hold to speak'}</span>
              </div>
            ) : (
              <div className={`${isCancelPending ? 'bg-red-500' : 'bg-emerald-500'} rounded-full px-3 flex items-center gap-2 transition-colors duration-150`} style={{ height: '44px' }}>
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <div className="flex items-end gap-[2px] h-4">
                    {waveBarStyles.map((style, i) => (
                      <div key={i} className="w-[3px] bg-white/70 rounded-full" style={isCancelPending ? { height: style.height } : style} />
                    ))}
                  </div>
                  <span className="text-sm text-white font-medium tabular-nums">{recordingTime}"</span>
                  <span className="text-[10px] text-white/60 tabular-nums">/ 60s</span>
                </div>
                <span className="text-[10px] text-white/80 flex-shrink-0">{t.ai?.releaseToSend || 'Release to send'}</span>
              </div>
            )}
          </div>
        )}

        {inputMode === 'text' && (
          <div className="flex-1 min-w-0 relative" style={{ minHeight: '44px' }}>
            <textarea
              value={textMessage}
              onChange={(e) => {
                setTextMessage(e.target.value);
                const el = e.target;
                el.style.height = '44px';
                if (e.target.value && el.scrollHeight > 44) {
                  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSendText();
                }
              }}
              placeholder={t.community?.typeMessage || 'Type a message...'}
              className={`w-full bg-emerald-50 rounded-full text-emerald-900 placeholder-emerald-400 outline-none focus:ring-2 focus:ring-emerald-300 transition-[box-shadow] resize-none overflow-y-auto shadow-sm ${isRTL ? 'pr-11 pl-4' : 'pl-4 pr-11'}`}
              ref={textInputRef}
              onFocus={handleInputFocus}
              style={{ display: 'block', height: '44px', minHeight: '44px', maxHeight: '120px', lineHeight: '20px', paddingTop: '12px', paddingBottom: '12px', boxSizing: 'border-box', fieldSizing: 'fixed', fontSize: 'clamp(13px, 3.5vw, 15px)' } as React.CSSProperties}
            />
            {textMessage.trim() && (
              <button
                type="button"
                onClick={handleSendText}
                disabled={isSending}
                className={`absolute bottom-1.5 w-8 h-8 flex items-center justify-center active:scale-90 transition-all disabled:opacity-40 disabled:active:scale-100 ${isRTL ? 'left-1.5' : 'right-1.5'}`}
              >
                <Send className="w-5 h-5 text-emerald-600" strokeWidth={2.5} />
              </button>
            )}
          </div>
        )}

        <button
          type="button"
          disabled={isPreparingImage || isSending}
          className="w-11 h-11 flex items-center justify-center bg-emerald-50 text-emerald-600 rounded-full active:scale-90 transition-all flex-shrink-0 disabled:opacity-40 disabled:active:scale-100"
          onClick={() => setShowImageSourceSheet(true)}
        >
          <Camera className="w-[18px] h-[18px]" />
        </button>
      </div>

      {showImageSourceSheet && (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeImageSourceSheet();
          }}
          style={{
            backgroundColor: imageSheetAnim === "visible" ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0)",
            transition: "background-color 200ms ease-out",
          }}
        >
          <div
            className="w-full max-w-lg mx-2 mb-2 safe-bottom"
            style={{
              transform: imageSheetAnim === "visible" ? "translateY(0)" : "translateY(100%)",
              opacity: imageSheetAnim === "leaving" ? 0 : 1,
              transition:
                imageSheetAnim === "leaving"
                  ? "transform 200ms ease-in, opacity 150ms ease-in"
                  : "transform 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease-out",
            }}
          >
            <div className="bg-white rounded-2xl overflow-hidden shadow-xl">
              <div className="px-4 pt-4 pb-2 text-center">
                <p className="text-gray-400" style={{ fontSize: "13px" }}>
                  {t.camera?.chooseSource || "Choose image source"}
                </p>
              </div>
              <button
                type="button"
                className="w-full flex items-center justify-center gap-3 py-4 active:bg-gray-50 transition-colors"
                style={{ boxShadow: "0 -1px 0 rgba(0,0,0,0.04)" }}
                onClick={handlePickCamera}
              >
                <Camera className="w-5 h-5 text-emerald-600" />
                <span className="text-emerald-600" style={{ fontSize: "17px" }}>
                  {t.camera?.takePicture || t.camera?.takePhoto || "Take Photo"}
                </span>
              </button>
              <button
                type="button"
                className="w-full flex items-center justify-center gap-3 py-4 active:bg-gray-50 transition-colors"
                style={{ boxShadow: "0 -1px 0 rgba(0,0,0,0.04)" }}
                onClick={handlePickAlbum}
              >
                <ImageIcon className="w-5 h-5 text-emerald-600" />
                <span className="text-emerald-600" style={{ fontSize: "17px" }}>
                  {t.camera?.chooseFromAlbum || "Choose from Album"}
                </span>
              </button>
            </div>
            <button
              type="button"
              className="mt-2 w-full bg-white rounded-2xl py-4 flex items-center justify-center active:bg-gray-50 transition-colors shadow-xl"
              onClick={closeImageSourceSheet}
            >
              <span className="text-gray-900 font-medium" style={{ fontSize: "17px" }}>
                {t.common?.cancel || "Cancel"}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

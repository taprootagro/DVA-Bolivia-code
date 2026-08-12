import { X, Phone, Video, Mic, MicOff, VideoOff, Volume2, User } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { chatService } from "../services/ChatProxyService";
import { useLanguage } from "../hooks/useLanguage";
import { isProductionBuild } from "../utils/productionGuard";

interface CallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  contactName: string;
  contactAvatar: string;
  callType: "audio" | "video";
  callStatus: "calling" | "connected" | "ended";
}

export function CallDialog({
  isOpen,
  onClose,
  contactName,
  contactAvatar,
  callType,
  callStatus: initialStatus,
}: CallDialogProps) {
  const { isRTL } = useLanguage();
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [callStatus, setCallStatus] = useState(initialStatus);
  const [agoraReady, setAgoraReady] = useState(false);
  const [tokenInfo, setTokenInfo] = useState<{ token: string; appId: string; uid: string | number } | null>(null);
  const durationTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 过渡动画状态
  const [animPhase, setAnimPhase] = useState<'entering' | 'visible' | 'leaving'>('entering');

  useEffect(() => {
    if (isOpen) {
      setAnimPhase('entering');
      const raf = requestAnimationFrame(() => setAnimPhase('visible'));
      return () => cancelAnimationFrame(raf);
    }
  }, [isOpen]);

  // Step 1: Request token from backend proxy when call starts
  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    const channelName = `call-${contactName}-${Date.now()}`;

    (async () => {
      try {
        console.log("[CallDialog] Requesting IM token via backend proxy...");
        const info = await chatService.joinChannel(channelName);
        if (cancelled) return;

        setTokenInfo(info);
        setAgoraReady(true);
        console.log(`[CallDialog] Token received for ${chatService.providerInfo.name}, ready to join channel`);

        // TODO: When IM provider SDK is installed, use the token here:
        // For CometChat: CometChat.initiateCall(callObj);
        // For Tencent IM: use TRTC SDK to join channel
        // if (callType === "audio") {
        //   const audioTrack = await AgoraRTC.createMicrophoneAudioTrack();
        //   await client.publish([audioTrack]);
        // } else {
        //   const [audioTrack, videoTrack] = await AgoraRTC.createMicrophoneAndCameraTracks();
        //   await client.publish([audioTrack, videoTrack]);
        // }

        // Simulate connection for mock mode (dev only)
        if (chatService.mode === "mock" && !isProductionBuild()) {
          setTimeout(() => {
            if (!cancelled) setCallStatus("connected");
          }, 2000);
        }
      } catch (error) {
        console.error("[CallDialog] Failed to get token:", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, contactName, callType]);

  // Step 2: Track call duration when connected
  useEffect(() => {
    if (callStatus === "connected") {
      durationTimerRef.current = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    }

    return () => {
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
        durationTimerRef.current = null;
      }
    };
  }, [callStatus]);

  // Cleanup on close
  const handleClose = useCallback(() => {
    setAnimPhase('leaving');
    setTimeout(() => {
      setCallStatus("ended");
      setCallDuration(0);
      setAgoraReady(false);
      setTokenInfo(null);
      onClose();
    }, 150);
  }, [onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-90 z-50 flex flex-col items-center justify-center"
      style={{
        transform: animPhase === 'visible' ? 'none' : 'scale(0.96)',
        opacity: animPhase === 'visible' ? 1 : 0,
        transition: animPhase === 'leaving'
          ? 'transform 150ms ease-in, opacity 150ms ease-in'
          : 'transform 200ms ease-out, opacity 200ms ease-out',
        willChange: animPhase === 'visible' ? 'auto' : 'transform, opacity',
      }}
    >
      {/* 关闭按钮 */}
      <button
        onClick={handleClose}
        className={`absolute top-4 w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center text-white ${isRTL ? 'left-4' : 'right-4'}`}
      >
        <X className="w-5 h-5" />
      </button>

      {/* 通话主体 */}
      <div className="flex flex-col items-center gap-8 px-6">
        {/* 对方头像 */}
        <div className="relative">
          {contactAvatar ? (
            <img
              src={contactAvatar}
              alt={contactName}
              className="w-32 h-32 rounded-full object-cover border-4 border-emerald-500 bg-gray-900"
            />
          ) : (
            <div className="w-32 h-32 rounded-full border-4 border-emerald-500 bg-white flex items-center justify-center">
              <User className="w-16 h-16 text-emerald-600" strokeWidth={2.2} aria-hidden />
            </div>
          )}
          {/* 通话状态指示器 */}
          {callStatus === "calling" && (
            <div className="absolute inset-0 rounded-full border-4 border-emerald-500 animate-ping"></div>
          )}
        </div>

        {/* 联系人名称 */}
        <div className="text-center">
          <h2 className="text-white text-2xl font-medium">{contactName}</h2>
          <p className="text-gray-400 text-sm mt-2">
            {callStatus === "calling" && "正在呼叫..."}
            {callStatus === "connected" && `通话中 ${Math.floor(callDuration / 60)}:${(callDuration % 60).toString().padStart(2, '0')}`}
            {callStatus === "ended" && "通话已结束"}
          </p>
        </div>

        {/* IM Token 状态指示 */}
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${agoraReady ? "bg-emerald-400" : "bg-amber-400 animate-pulse"}`} />
          <span className="text-xs text-gray-500">
            {agoraReady
              ? `${chatService.providerInfo.name} Token Ready (${chatService.mode} mode)`
              : "Requesting token..."}
          </span>
        </div>

        {/* 控制按钮 */}
        <div className="flex items-center gap-6">
          {/* 麦克风开关 */}
          <button
            onClick={() => {
              setIsMuted(!isMuted);
              // TODO: localAudioTrack.setEnabled(!isMuted);
            }}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
              isMuted ? "bg-red-500" : "bg-gray-700"
            }`}
          >
            {isMuted ? (
              <MicOff className="w-6 h-6 text-white" />
            ) : (
              <Mic className="w-6 h-6 text-white" />
            )}
          </button>

          {/* 挂断按钮 */}
          <button
            onClick={handleClose}
            className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg"
          >
            <Phone className="w-7 h-7 text-white rotate-[135deg]" />
          </button>

          {/* 视频开关（仅视频通话显示） */}
          {callType === "video" && (
            <button
              onClick={() => {
                setIsVideoOff(!isVideoOff);
                // TODO: localVideoTrack.setEnabled(!isVideoOff);
              }}
              className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
                isVideoOff ? "bg-red-500" : "bg-gray-700"
              }`}
            >
              {isVideoOff ? (
                <VideoOff className="w-6 h-6 text-white" />
              ) : (
                <Video className="w-6 h-6 text-white" />
              )}
            </button>
          )}

          {/* 扬声器 */}
          {callType === "audio" && (
            <button className="w-14 h-14 rounded-full bg-gray-700 flex items-center justify-center">
              <Volume2 className="w-6 h-6 text-white" />
            </button>
          )}
        </div>

        {/* 提示信息 */}
        <div className="text-center text-gray-500 text-xs mt-4">
          {chatService.mode === "mock" ? (
            <>
              <p>Backend Proxy Pattern: Token via Supabase Edge Function</p>
              <p className="mt-1">当前为 Mock 模式 - 需安装 {chatService.providerInfo.name} SDK 并连接 Supabase</p>
            </>
          ) : (
            <>
              <p>{chatService.providerInfo.name} Backend Proxy Mode Active</p>
              <p className="mt-1">需安装 {chatService.providerInfo.name} SDK 以启用实时通话</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
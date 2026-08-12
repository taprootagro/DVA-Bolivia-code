import { useState, useRef, useEffect, useCallback } from "react";
import { isAppPermissionEnabled } from "../../../utils/appPermissions";

/**
 * useVoiceRecorder — 真实麦克风录音 Hook
 *
 * 关键原则（用户隐私）：
 * 1. 仅在 startRecording 时申请麦克风权限 (getUserMedia)
 * 2. 录音结束/取消后 **立即** 停止所有 MediaStream tracks，释放麦克风
 * 3. 绝不在后台保持麦克风打开
 */
export function useVoiceRecorder(sendVoiceMessage: (duration: number, audioBlob: Blob) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [isCancelPending, setIsCancelPending] = useState(false);
  const [micPermissionDenied, setMicPermissionDenied] = useState(false);

  const recordingTimeRef = useRef(0);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRecordingRef = useRef(false);
  const isCancelPendingRef = useRef(false);

  // ★ 追踪是否有一个 pending 的 getUserMedia 调用（权限弹窗期间为 true）
  // touchEnd/stopRecording 会将其设为 false，让 getUserMedia resolve 后放弃录音
  const pendingStartRef = useRef(false);

  // MediaRecorder 相关
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const voiceCancelledRef = useRef(false);
  // Store the recorded blob so stopRecording/60s-auto-stop can access it
  const audioBlobRef = useRef<Blob | null>(null);

  // 彻底释放麦克风 — 所有退出路径都必须调用
  const releaseMediaStream = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => {
        track.stop();
      });
      mediaStreamRef.current = null;
    }
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch { /* already stopped */ }
      }
      mediaRecorderRef.current = null;
    }
  }, []);

  // 组件卸载时确保释放
  useEffect(() => {
    return () => {
      releaseMediaStream();
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
    };
  }, [releaseMediaStream]);

  const startRecording = useCallback(async () => {
    if (isRecordingRef.current) return;

    if (!isAppPermissionEnabled('microphone')) {
      setMicPermissionDenied(true);
      return;
    }

    // 先取消任何正在播放的TTS
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    // 重置权限拒绝提示
    setMicPermissionDenied(false);

    // ★ 设置 pendingStartRef 为 true，表示正在等待 getUserMedia
    pendingStartRef.current = true;

    try {
      // 真正申请麦克风权限
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // ★ 权限弹窗期间手指抬起（touchEnd 调用了 stopRecording/cancelRecording）
      // pendingStartRef 已被清为 false → 放弃录音，立即释放麦克风
      if (!pendingStartRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      mediaStreamRef.current = stream;
      voiceCancelledRef.current = false;

      // 创建 MediaRecorder
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      // 录音数据收集（虽然当前 IM 后端是 mock，但录制是真实的）
      const audioChunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      recorder.onstop = () => {
        // ★ 立即释放麦克风 — 不在后台保持
        stream.getTracks().forEach(t => t.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;

        // 如果是取消，不发送
        if (voiceCancelledRef.current) {
          audioBlobRef.current = null;
          return;
        }

        // 创建真实的 audioBlob，供 sendVoiceMessage 使用
        const blob = new Blob(audioChunks, { type: recorder.mimeType || 'audio/webm' });
        audioBlobRef.current = blob;
      };

      recorder.start(250); // 每250ms收集数据

      // 录音状态更新
      isRecordingRef.current = true;
      isCancelPendingRef.current = false;
      recordingTimeRef.current = 0;
      setIsRecording(true);
      setIsCancelPending(false);
      setRecordingTime(0);

      // 计时器
      const timer = setInterval(() => {
        recordingTimeRef.current += 1;
        const t = recordingTimeRef.current;
        setRecordingTime(t);
        if (t >= 60) {
          clearInterval(timer);
          recordingTimerRef.current = null;
          if (isRecordingRef.current) {
            isRecordingRef.current = false;
            isCancelPendingRef.current = false;
            setIsRecording(false);
            setIsCancelPending(false);
            const duration = recordingTimeRef.current;
            recordingTimeRef.current = 0;
            setRecordingTime(0);
            // 停止 MediaRecorder（触发 onstop 释放麦克风）
            voiceCancelledRef.current = false;
            if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
              mediaRecorderRef.current.stop();
            }
            // Wait a tick for onstop to fire and set audioBlobRef
            setTimeout(() => {
              const blob = audioBlobRef.current;
              audioBlobRef.current = null;
              if (blob && blob.size > 0) {
                sendVoiceMessage(duration, blob);
              }
            }, 50);
          }
        }
      }, 1000);

      recordingTimerRef.current = timer;

    } catch (err) {
      // 麦克风权限被拒绝或不可用
      console.error('[Voice] Microphone access denied:', err);
      setMicPermissionDenied(true);
      // 确保彻底清理
      releaseMediaStream();
      isRecordingRef.current = false;
      setIsRecording(false);
      // 3秒后自动清除权限拒绝提示
      setTimeout(() => setMicPermissionDenied(false), 3000);
    } finally {
      // ★ 无论成功或失败，都设置 pendingStartRef 为 false
      pendingStartRef.current = false;
    }
  }, [sendVoiceMessage, releaseMediaStream]);

  const stopRecording = useCallback(() => {
    // ★ 无论是否正在录音，都清除 pending（处理权限弹窗期间手指抬起的情况）
    pendingStartRef.current = false;

    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }

    const duration = recordingTimeRef.current;
    const wasCancelled = isCancelPendingRef.current;

    isRecordingRef.current = false;
    isCancelPendingRef.current = false;
    recordingTimeRef.current = 0;
    setIsRecording(false);
    setIsCancelPending(false);
    setRecordingTime(0);

    // 停止 MediaRecorder（触发 onstop → 释放麦克风）
    if (wasCancelled || duration < 1) {
      voiceCancelledRef.current = true;
    } else {
      voiceCancelledRef.current = false;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch { /* already stopped */ }
    } else {
      // MediaRecorder 已经停了，手动释放 stream
      releaseMediaStream();
    }

    if (!wasCancelled && duration > 0) {
      // Wait a tick for onstop to fire and set audioBlobRef
      setTimeout(() => {
        const blob = audioBlobRef.current;
        audioBlobRef.current = null;
        if (blob && blob.size > 0) {
          sendVoiceMessage(duration, blob);
        }
      }, 50);
    }
  }, [sendVoiceMessage, releaseMediaStream]);

  const cancelRecording = useCallback(() => {
    // ★ 无论是否正在录音，都清除 pending
    pendingStartRef.current = false;

    if (!isRecordingRef.current) return;
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    isRecordingRef.current = false;
    isCancelPendingRef.current = false;
    recordingTimeRef.current = 0;
    setIsRecording(false);
    setIsCancelPending(false);
    setRecordingTime(0);

    // 取消 — 停止 MediaRecorder 并释放麦克风
    voiceCancelledRef.current = true;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch { /* already stopped */ }
    } else {
      releaseMediaStream();
    }
  }, [releaseMediaStream]);

  const setCancelPending = useCallback((pending: boolean) => {
    isCancelPendingRef.current = pending;
    setIsCancelPending(pending);
  }, []);

  // 清除权限拒绝提示
  const clearMicDenied = useCallback(() => {
    setMicPermissionDenied(false);
  }, []);

  return {
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
    clearMicDenied,
  };
}
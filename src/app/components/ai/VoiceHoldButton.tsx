import { Mic, MicOff } from "lucide-react";
import type { VoiceHoldRecorder } from "../../hooks/useVoiceHoldRecorder";

// Fix 5: 预生成波形条高度，避免在 render 中调用 Math.random()
const WAVE_HEIGHTS = [1.5, 3, 2, 3.5, 1.5, 3, 2].map(h => h * 4);

type VoiceHoldButtonProps = {
  recorder: VoiceHoldRecorder;
  enabled: boolean;
  idleLabel: string;
  micDeniedLabel: string;
  releaseLabel: string;
};

/** 按住说话；手指拖出按钮 20px 以外松手即取消。 */
export function VoiceHoldButton({ recorder, enabled, idleLabel, micDeniedLabel, releaseLabel }: VoiceHoldButtonProps) {
  const { isRecording, voiceTime, cancelPending, micPermissionDenied } = recorder;
  return (
    <div
      className="flex-1 min-w-0 select-none"
      style={{ height: '44px' }}
      onTouchStart={(e) => {
        if (!enabled || micPermissionDenied) return;
        const touch = e.touches[0];
        const rect = e.currentTarget.getBoundingClientRect();
        (e.currentTarget as any).__startY = touch?.clientY || 0;
        (e.currentTarget as any).__btnRect = rect;
        recorder.start();
      }}
      onTouchMove={(e) => {
        if (!recorder.isRecordingRef.current) return;
        const touch = e.touches[0];
        const rect = (e.currentTarget as any).__btnRect as DOMRect;
        if (!rect || !touch) return;
        const isOutside =
          touch.clientX < rect.left - 20 ||
          touch.clientX > rect.right + 20 ||
          touch.clientY < rect.top - 20 ||
          touch.clientY > rect.bottom + 20;
        if (isOutside !== recorder.cancelPendingRef.current) {
          recorder.setCancelPending(isOutside);
        }
      }}
      onTouchEnd={() => recorder.end()}
      onTouchCancel={() => recorder.cancel()}
      onMouseDown={() => { if (enabled && !micPermissionDenied) recorder.start(); }}
      onMouseUp={() => recorder.end()}
      onMouseLeave={() => {
        if (recorder.isRecordingRef.current) {
          recorder.setCancelPending(true);
          recorder.end();
        }
      }}
    >
      {/* Fix 3: 麦克风权限被拒绝 */}
      {micPermissionDenied ? (
        <div className="bg-red-50 rounded-full text-center text-red-500 flex items-center justify-center shadow-sm" style={{ height: '44px', fontSize: 'clamp(11px, 3vw, 13px)' }}>
          <MicOff className="w-4 h-4 inline-block me-1.5 flex-shrink-0" />
          <span className="truncate">{micDeniedLabel}</span>
        </div>
      ) : !isRecording ? (
        /* Fix 4: enabled=false 时显示禁用态 + 提示 */
        <div className={`rounded-full text-center select-none flex items-center justify-center shadow-sm ${enabled ? 'bg-emerald-50 text-emerald-600 active:bg-emerald-500 active:text-white' : 'bg-gray-100 text-gray-400'} transition-colors`} style={{ height: '44px', fontSize: 'clamp(12px, 3.2vw, 14px)' }}>
          <Mic className="w-4 h-4 inline-block me-1.5 flex-shrink-0" />
          <span className="truncate">{idleLabel}</span>
        </div>
      ) : (
        <div className={`${cancelPending ? 'bg-red-500' : 'bg-emerald-500'} rounded-full px-3 flex items-center gap-2 transition-colors duration-150`} style={{ height: '44px' }}>
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <div className="flex items-end gap-[2px] h-4">
              {/* Fix 5: 使用预计算的 WAVE_HEIGHTS 替代 Math.random() */}
              {WAVE_HEIGHTS.map((h, i) => (
                <div key={i} className="w-[3px] bg-white/70 rounded-full" style={cancelPending ? {
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
          <span className="text-[10px] text-white/80 flex-shrink-0">{releaseLabel}</span>
        </div>
      )}
    </div>
  );
}

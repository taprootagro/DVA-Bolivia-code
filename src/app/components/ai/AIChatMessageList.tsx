import { memo } from "react";
import { Pause, Play } from "lucide-react";
import { AIMarkdown } from "./AIMarkdown";

export type AIChatMessage = {
  role: 'user' | 'ai';
  text: string;
  image?: string;
  voiceDuration?: number;
  audioUrl?: string;
};

const WAVE_HEIGHTS = [1.5, 3, 2, 3.5, 1.5, 3, 2];

type AIChatMessageListProps = {
  messages: AIChatMessage[];
  playingVoiceIdx: number | null;
  onToggleVoice: (idx: number, duration: number) => void;
  /** Tap on an AI text bubble → read it aloud */
  onSpeak: (text: string) => void;
  isRTL: boolean;
};

export const AIChatMessageList = memo(function AIChatMessageList({
  messages,
  playingVoiceIdx,
  onToggleVoice,
  onSpeak,
  isRTL,
}: AIChatMessageListProps) {
  return (
    <>
      {messages.map((msg, idx) => {
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
              onClick={() => msg.role === 'ai' && !msg.text.startsWith('⚠️') && onSpeak(msg.text)}
            >
              {msg.image && (
                <img src={msg.image} alt="" className="max-w-44 max-h-48 w-auto h-auto rounded-xl mb-1" />
              )}
              {isVoice ? (
                <button
                  className="flex items-center gap-2 min-w-[80px] w-full"
                  onClick={(e) => { e.stopPropagation(); onToggleVoice(idx, msg.voiceDuration!); }}
                >
                  {isPlaying
                    ? <Pause className="w-3.5 h-3.5 flex-shrink-0" />
                    : <Play className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" />
                  }
                  <div className="flex items-end gap-[2px] h-4">
                    {WAVE_HEIGHTS.map((h, i) => (
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
                <div className="leading-relaxed" style={{ fontSize: 'clamp(13px, 3.5vw, 15px)' }}><AIMarkdown text={msg.text} /></div>
              ) : msg.text ? (
                <p className="leading-relaxed" style={{ fontSize: 'clamp(13px, 3.5vw, 15px)' }}>{msg.text}</p>
              ) : null}
            </div>
          </div>
        );
      })}
    </>
  );
});

import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ChatMessage } from "../../../../services/ChatProxyService";

vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: "/home/community" }),
}));

vi.mock("../../../../hooks/useLanguage", () => ({
  useLanguage: () => ({ language: "en" }),
}));

vi.mock("../../../../utils/capacitor-bridge", () => ({
  textToSpeech: {
    stop: vi.fn(() => Promise.resolve()),
    speakQueue: vi.fn(() => Promise.resolve()),
  },
}));

import { useVoiceSystem } from "../useVoiceSystem";

function voice(id: string, audioUrl = ""): ChatMessage {
  return {
    id,
    channelName: "ch-1",
    senderId: "me",
    type: "voice",
    content: "[Voice]",
    audioUrl,
    duration: 3,
    timestamp: 0,
    status: "sent",
    read: true,
  } as ChatMessage;
}

describe("useVoiceSystem toggleVoicePlay", () => {
  it("keeps a stable identity when messages change and still finds new messages", () => {
    const playSpy = vi.fn(() => Promise.resolve());
    const audios: string[] = [];
    vi.stubGlobal(
      "Audio",
      class {
        src: string;
        currentTime = 0;
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(src: string) {
          this.src = src;
          audios.push(src);
        }
        play = playSpy;
        pause() {}
      },
    );
    try {
      const { result, rerender } = renderHook(
        ({ msgs }) => useVoiceSystem(msgs, "me"),
        { initialProps: { msgs: [voice("v1", "blob:one")] } },
      );
      const first = result.current.toggleVoicePlay;

      rerender({ msgs: [voice("v1", "blob:one"), voice("v2", "blob:two")] });
      expect(result.current.toggleVoicePlay).toBe(first);

      act(() => result.current.toggleVoicePlay("v2", 3));
      expect(result.current.playingVoiceId).toBe("v2");
      expect(audios).toContain("blob:two");
      expect(playSpy).toHaveBeenCalled();

      act(() => result.current.toggleVoicePlay("v2", 3));
      expect(result.current.playingVoiceId).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

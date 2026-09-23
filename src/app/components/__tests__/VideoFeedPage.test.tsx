import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VideoFeedPage } from "../VideoFeedPage";

vi.mock("../../hooks/ConfigProvider", () => ({
  useConfigContext: () => ({
    config: {
      liveStreams: [
        {
          id: 1,
          title: "YouTube one",
          videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          thumbnail: "",
          viewers: "1",
        },
        {
          id: 2,
          title: "YouTube two",
          videoUrl: "https://youtu.be/jNQXAC9IVRw",
          thumbnail: "",
          viewers: "2",
        },
      ],
    },
  }),
}));

vi.mock("../../hooks/useCmsMediaUrl", () => ({
  useCmsMediaUrl: () => ({ resolve: (url: string) => url }),
}));

vi.mock("../../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: {
      video: { sampleVideo: "Play", views: "{count} views" },
      common: { cancel: "Cancel" },
    },
  }),
}));

vi.mock("../../hooks/useBackHandler", () => ({
  useBackHandler: () => {},
}));

vi.mock("../../utils/wxJsSdk", () => ({
  isWeChatBrowser: () => false,
  initWxSdk: vi.fn(),
  setupWxShare: vi.fn(),
}));

vi.mock("../../utils/capacitor-bridge", () => ({
  bridge: { app: { openUrl: vi.fn() } },
}));

function dispatchYoutubePlaying() {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://www.youtube-nocookie.com",
        data: JSON.stringify({ event: "onStateChange", info: 1 }),
      }),
    );
  });
}

describe("VideoFeedPage embed swipe surface", () => {
  it("does not autoplay, and does not capture the first play tap", () => {
    render(<VideoFeedPage onClose={() => {}} />);

    const iframe = screen.getByTitle("YouTube one");
    expect(iframe.tagName).toBe("IFRAME");
    const src = iframe.getAttribute("src") ?? "";
    expect(src).not.toContain("autoplay=1");
    expect(src).toContain("enablejsapi=1");
    expect(iframe.className).toContain("pointer-events-auto");

    const hint = screen.getByTestId("embed-play-hint");
    expect(hint.className).toContain("pointer-events-none");
    expect(screen.queryByRole("button", { name: "Play" })).not.toBeInTheDocument();
  });

  it("hides the play hint when the embed reports playing", () => {
    render(<VideoFeedPage onClose={() => {}} />);
    expect(screen.getByTestId("embed-play-hint")).toBeInTheDocument();

    dispatchYoutubePlaying();

    expect(screen.queryByTestId("embed-play-hint")).not.toBeInTheDocument();
    expect(screen.getByTestId("video-feed-info").getAttribute("data-timeline-hole")).toBe("1");
  });

  it("still switches videos on vertical swipe after the embed is playing", () => {
    render(<VideoFeedPage onClose={() => {}} />);

    dispatchYoutubePlaying();

    const info = screen.getByTestId("video-feed-info");
    fireEvent.touchStart(info, { targetTouches: [{ clientY: 400 }] });
    fireEvent.touchMove(info, { targetTouches: [{ clientY: 280 }] });
    fireEvent.touchEnd(info);

    expect(screen.getByTitle("YouTube two")).toBeInTheDocument();
  });
});

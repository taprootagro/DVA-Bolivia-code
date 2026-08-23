import { fireEvent, render, screen } from "@testing-library/react";
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

describe("VideoFeedPage embed swipe surface", () => {
  it("exposes the player timeline after playback so seek clicks reach the iframe", () => {
    render(<VideoFeedPage onClose={() => {}} />);

    const iframe = screen.getByTitle("YouTube one");
    expect(iframe.tagName).toBe("IFRAME");
    expect(iframe.className).toContain("pointer-events-auto");

    const overlay = screen.getByRole("button", { name: "Play" });
    expect(overlay.getAttribute("data-timeline-hole")).toBe("0");

    fireEvent.click(overlay);

    expect(iframe.className).toContain("pointer-events-auto");
    expect(screen.getByRole("button", { name: "Play" }).getAttribute("data-timeline-hole")).toBe("1");
  });

  it("still switches videos on vertical swipe after the embed is playing", () => {
    render(<VideoFeedPage onClose={() => {}} />);

    const overlay = screen.getByRole("button", { name: "Play" });
    fireEvent.click(overlay);

    fireEvent.touchStart(overlay, { targetTouches: [{ clientY: 400 }] });
    fireEvent.touchMove(overlay, { targetTouches: [{ clientY: 280 }] });
    fireEvent.touchEnd(overlay);

    expect(screen.getByTitle("YouTube two")).toBeInTheDocument();
  });
});

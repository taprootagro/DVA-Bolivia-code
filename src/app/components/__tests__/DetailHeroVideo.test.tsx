import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DetailHeroVideo } from "../DetailHeroVideo";

vi.mock("../../utils/videoEmbedFromUrl", () => ({
  resolveLiveStreamEmbedUrl: vi.fn((url: string) => {
    if (url.includes("youtube.com") || url.includes("youtu.be")) {
      return "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
    }
    if (url.includes("vimeo.com")) {
      return "https://player.vimeo.com/video/123456789";
    }
    if (url.includes("bilibili.com")) {
      return "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD";
    }
    return null;
  }),
}));

describe("DetailHeroVideo", () => {
  it("renders iframe for YouTube share URL", () => {
    render(
      <DetailHeroVideo
        videoUrl="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        alt="Demo"
      />,
    );
    const iframe = screen.getByTitle("Demo");
    expect(iframe.tagName).toBe("IFRAME");
    expect(iframe).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  });

  it("renders iframe for Vimeo share URL", () => {
    render(<DetailHeroVideo videoUrl="https://vimeo.com/123456789" alt="Vimeo" />);
    expect(screen.getByTitle("Vimeo")).toHaveAttribute(
      "src",
      "https://player.vimeo.com/video/123456789",
    );
  });

  it("renders iframe for Bilibili share URL", () => {
    render(
      <DetailHeroVideo
        videoUrl="https://www.bilibili.com/video/BV1xx411c7mD"
        alt="Bilibili"
      />,
    );
    expect(screen.getByTitle("Bilibili")).toHaveAttribute(
      "src",
      "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD",
    );
  });

  it("renders video element for direct MP4 URL", () => {
    render(
      <DetailHeroVideo
        videoUrl="https://cdn.example.com/demo.mp4"
        posterUrl="https://cdn.example.com/poster.jpg"
      />,
    );
    const video = document.querySelector("video");
    expect(video).toBeInTheDocument();
    expect(video).toHaveAttribute("src", "https://cdn.example.com/demo.mp4");
    expect(screen.queryByTitle("Video")).not.toBeInTheDocument();
  });

  it("shows blurred poster behind embed iframe when posterUrl provided", () => {
    render(
      <DetailHeroVideo
        videoUrl="https://youtu.be/dQw4w9WgXcQ"
        posterUrl="https://cdn.example.com/poster.jpg"
        alt="With poster"
      />,
    );
    expect(screen.getByTitle("With poster")).toBeInTheDocument();
    const poster = document.querySelector('img[aria-hidden="true"]');
    expect(poster).toHaveAttribute("src", "https://cdn.example.com/poster.jpg");
  });
});

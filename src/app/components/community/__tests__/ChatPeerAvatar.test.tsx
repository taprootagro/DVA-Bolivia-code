import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: {
      community: {
        userIdLabel: "User ID",
        copyUserId: "Copy",
        userIdCopied: "Copied",
        gotIt: "Got it",
      },
    },
  }),
}));

vi.mock("../../../hooks/useCmsMediaUrl", () => ({
  useCmsMediaUrl: () => ({
    resolve: (value: string | null | undefined) => {
      const raw = (value || "").trim();
      if (!raw) return "";
      if (/^https?:\/\//i.test(raw) || raw.startsWith("data:") || raw.startsWith("blob:")) {
        return raw;
      }
      return `https://cdn.example/${raw.replace(/^\/+/, "")}`;
    },
  }),
}));

vi.mock("../../../services/chatUiMemory", () => ({
  peekCachedObjectUrl: () => undefined,
  resolveCachedMediaUrl: async (url: string) => url,
}));

import { ChatPeerAvatar } from "../ChatPeerAvatar";

describe("ChatPeerAvatar", () => {
  it("shows the user icon when there is no avatar", () => {
    const { container } = render(<ChatPeerAvatar avatar="" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("requests a storage path from the media host, not the page origin", () => {
    const { container } = render(<ChatPeerAvatar avatar="avatars/u.webp" />);
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://cdn.example/avatars/u.webp",
    );
  });

  it("drops the image after a load error and does not send a referrer", () => {
    const { container } = render(
      <ChatPeerAvatar avatar="https://lh3.googleusercontent.com/a/photo" />,
    );
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
    fireEvent.error(img!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("shows the user id without opening the parent row", () => {
    const onPress = vi.fn();
    render(
      <button type="button" onClick={onPress}>
        <ChatPeerAvatar avatar="" userId="user-123" />
      </button>,
    );
    fireEvent.click(screen.getByLabelText("User ID"));
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByText("user-123")).toBeTruthy();
  });
});

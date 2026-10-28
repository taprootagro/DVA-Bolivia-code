import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../utils/auth", () => ({
  getAccessToken: vi.fn(() => "user-jwt"),
  syncAccessTokenFromSupabaseSession: vi.fn(async () => {}),
}));

vi.mock("../../utils/supabaseBrowser", () => ({
  getSupabaseBrowserClient: vi.fn(() => null),
}));

import { SupabaseChatAdapter } from "../SupabaseChatAdapter";

function makeAdapter(): SupabaseChatAdapter {
  return new SupabaseChatAdapter({
    imMode: "im-provider-direct",
    chatProvider: "supabase",
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "anon-key",
  } as never);
}

describe("chat media upload size guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects a blob larger than the signed maxBytes before the Storage PUT", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          uploadUrl: "https://example.supabase.co/storage/v1/object/upload/sign/chat-media/x",
          token: "t",
          objectPath: "ch-1/x.webm",
          publicUrl: "https://example.supabase.co/storage/v1/object/public/chat-media/ch-1/x.webm",
          maxBytes: 4,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await makeAdapter().sendMessage({
      id: "c1",
      content: "",
      type: "voice",
      senderId: "user-1",
      targetUserId: "peer-1",
      channelName: "ch-1",
      duration: 1,
      audioBlob: new Blob(["0123456789"], { type: "audio/webm" }),
    });

    expect(res).toEqual({ success: false, error: "CHAT_MEDIA_TOO_LARGE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stores the private object path from /upload/sign as media_url", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/upload/sign")) {
        return new Response(
          JSON.stringify({
            uploadUrl: "https://example.supabase.co/storage/v1/object/upload/sign/chat-media/ch-1/x.webm",
            token: "t",
            objectPath: "ch-1/x.webm",
            publicUrl: "ch-1/x.webm",
            private: true,
            maxBytes: 1_000_000,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/object/upload/sign/")) {
        return new Response("", { status: 200 });
      }
      if (url.endsWith("/messages")) {
        const body = JSON.parse(String(init?.body || "{}")) as { media_url?: string };
        expect(body.media_url).toBe("ch-1/x.webm");
        return new Response(
          JSON.stringify({
            message: { id: "m1", created_at: new Date().toISOString(), media_url: body.media_url },
          }),
          { status: 200 },
        );
      }
      return new Response("unexpected " + url, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await makeAdapter().sendMessage({
      id: "c1",
      content: "",
      type: "voice",
      senderId: "user-1",
      targetUserId: "peer-1",
      channelName: "ch-1",
      duration: 1,
      audioBlob: new Blob(["0123"], { type: "audio/webm" }),
    });

    expect(res.success).toBe(true);
    expect(res.mediaUrl).toBe("ch-1/x.webm");
    expect(fetchMock).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../imageCompressor", () => ({
  COMPRESS_PRESETS: { chat: {} },
  compressImageFile: vi.fn(),
  estimateDataUrlBytes: vi.fn((dataUrl: string) => {
    const comma = dataUrl.indexOf(",");
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    return Math.floor(b64.length * 0.75);
  }),
}));

import { compressImageFile } from "../imageCompressor";
import {
  prepareChatImageFromFile,
  CHAT_IMAGE_LIMITS,
} from "../chatImagePrepare";

const mockedCompress = vi.mocked(compressImageFile);

function tinyDataUrl(): string {
  return "data:image/webp;base64,UklGRg==";
}

function hugeDataUrl(): string {
  const b64Len = Math.ceil((CHAT_IMAGE_LIMITS.hardMaxBytes + 1) / 0.75);
  return `data:image/webp;base64,${"A".repeat(b64Len)}`;
}

describe("prepareChatImageFromFile", () => {
  beforeEach(() => {
    mockedCompress.mockReset();
  });

  it("returns ok for compressed image under hard max", async () => {
    mockedCompress.mockResolvedValue(tinyDataUrl());
    const file = new File([new Uint8Array([1, 2, 3])], "leaf.jpg", {
      type: "image/jpeg",
    });
    const result = await prepareChatImageFromFile(file);
    expect(result).toEqual({ ok: true, dataUrl: tinyDataUrl() });
    expect(mockedCompress).toHaveBeenCalledOnce();
  });

  it("rejects gif", async () => {
    const file = new File([new Uint8Array([1])], "anim.gif", {
      type: "image/gif",
    });
    const result = await prepareChatImageFromFile(file);
    expect(result).toEqual({ ok: false, code: "unsupported" });
    expect(mockedCompress).not.toHaveBeenCalled();
  });

  it("returns too_large when compressed output exceeds hard max", async () => {
    mockedCompress.mockResolvedValue(hugeDataUrl());
    const file = new File([new Uint8Array([1, 2, 3])], "big.jpg", {
      type: "image/jpeg",
    });
    const result = await prepareChatImageFromFile(file);
    expect(result).toEqual({ ok: false, code: "too_large" });
  });

  it("returns process_failed when compress throws", async () => {
    mockedCompress.mockRejectedValue(new Error("canvas failed"));
    const file = new File([new Uint8Array([1])], "x.jpg", {
      type: "image/jpeg",
    });
    const result = await prepareChatImageFromFile(file);
    expect(result).toEqual({ ok: false, code: "process_failed" });
  });
});

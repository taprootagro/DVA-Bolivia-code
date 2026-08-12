import { describe, expect, it, vi } from "vitest";
import {
  AI_VISION_IMAGE_LIMITS,
  estimateDataUrlBytes,
} from "../imageCompressor";
import {
  cloudAIGuard,
  isCloudAiImageSizeReady,
  prepareImageForCloudAI,
} from "../cloudAIGuard";

function dataUrlOfApproxBytes(bytes: number): string {
  const b64Len = Math.ceil(bytes / 0.75);
  return `data:image/webp;base64,${"A".repeat(b64Len)}`;
}

describe("cloud AI image size guard", () => {
  it("isCloudAiImageSizeReady accepts any size up to max", () => {
    const small = dataUrlOfApproxBytes(50 * 1024);
    const mid = dataUrlOfApproxBytes(150 * 1024);
    expect(isCloudAiImageSizeReady(small)).toBe(true);
    expect(isCloudAiImageSizeReady(mid)).toBe(true);
  });

  it("isCloudAiImageSizeReady rejects above max", () => {
    const huge = dataUrlOfApproxBytes(400 * 1024);
    expect(isCloudAiImageSizeReady(huge)).toBe(false);
  });

  it("prepareImageForCloudAI skips re-compress when already under max", async () => {
    const ready = dataUrlOfApproxBytes(50 * 1024);
    const compressSpy = vi.spyOn(cloudAIGuard, "compressImage");
    const out = await prepareImageForCloudAI(ready);
    expect(out).toBe(ready);
    expect(compressSpy).not.toHaveBeenCalled();
    compressSpy.mockRestore();
  });

  it("prepareImageForCloudAI compresses when above max", async () => {
    const huge = dataUrlOfApproxBytes(400 * 1024);
    const compressed = dataUrlOfApproxBytes(120 * 1024);
    const compressSpy = vi
      .spyOn(cloudAIGuard, "compressImage")
      .mockResolvedValue(compressed);
    const out = await prepareImageForCloudAI(huge);
    expect(compressSpy).toHaveBeenCalledOnce();
    expect(out).toBe(compressed);
    compressSpy.mockRestore();
  });

  it("documents AI vision max byte cap only", () => {
    expect(AI_VISION_IMAGE_LIMITS.maxBytes).toBe(250 * 1024);
    expect("minBytes" in AI_VISION_IMAGE_LIMITS).toBe(false);
    expect(estimateDataUrlBytes(dataUrlOfApproxBytes(50 * 1024))).toBeLessThan(
      100 * 1024,
    );
  });
});

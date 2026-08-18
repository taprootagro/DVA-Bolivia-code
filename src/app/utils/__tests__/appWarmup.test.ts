import { describe, expect, it, vi } from "vitest";
import { runWarmupBatches, WARMUP_BATCHES, warmupAllChunks } from "../appWarmup";

vi.mock("../capacitor-bridge", () => ({
  isNative: vi.fn(),
}));

import { isNative } from "../capacitor-bridge";

describe("appWarmup", () => {
  it("lists all route chunk loaders", () => {
    expect(WARMUP_BATCHES.flat()).toHaveLength(12);
  });

  it("runWarmupBatches invokes every loader in order", async () => {
    const a = vi.fn(async () => undefined);
    const b = vi.fn(async () => undefined);
    const c = vi.fn(async () => undefined);
    const schedule = (fn: () => void) => fn();

    await runWarmupBatches([[a], [b, c]], schedule);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
    expect(a.mock.invocationCallOrder[0]).toBeLessThan(b.mock.invocationCallOrder[0]);
  });

  it("warmupAllChunks skips on web", async () => {
    vi.mocked(isNative).mockReturnValue(false);
    await expect(warmupAllChunks()).resolves.toBeUndefined();
  });

  it("warmupAllChunks resolves on native", async () => {
    vi.mocked(isNative).mockReturnValue(true);
    await expect(warmupAllChunks()).resolves.toBeUndefined();
  });
});

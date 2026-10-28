import { describe, expect, it, vi } from "vitest";
import {
  ABORTED,
  AI_QUEUE_TIMEOUT,
  AI_TIMEOUT,
  QUEUE_MAX_ATTEMPTS,
  QUEUE_MAX_WAIT_MS,
  UPSTREAM_BUSY,
  queueRetryDelayMs,
} from "../../services/CloudAIService";

describe("cloud AI queue retry helpers", () => {
  it("queueRetryDelayMs applies ±30% jitter around server seconds", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(queueRetryDelayMs(8)).toBe(Math.round(8000 * 0.85));
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(queueRetryDelayMs(8)).toBe(Math.round(8000 * 1.15));
    vi.restoreAllMocks();
  });

  it("queueRetryDelayMs defaults invalid server seconds to 8s base", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const ms = queueRetryDelayMs(0);
    expect(ms).toBeGreaterThanOrEqual(Math.round(8000 * 0.85));
    expect(ms).toBeLessThanOrEqual(Math.round(8000 * 1.15));
    vi.restoreAllMocks();
  });

  it("exports aligned max wait and attempt caps", () => {
    expect(QUEUE_MAX_WAIT_MS).toBe(120_000);
    expect(QUEUE_MAX_ATTEMPTS).toBe(15);
    expect(AI_QUEUE_TIMEOUT).toBe("AI_QUEUE_TIMEOUT");
    expect(AI_TIMEOUT).toBe("AI_TIMEOUT");
    expect(UPSTREAM_BUSY).toBe("UPSTREAM_BUSY");
    expect(ABORTED).toBe("ABORTED");
  });
});

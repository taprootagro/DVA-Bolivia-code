import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  readContentSuperAdminCache,
  writeContentSuperAdminCache,
  clearContentSuperAdminCache,
  CONTENT_SUPER_ADMIN_CACHE_TTL_MS,
} from "../contentSuperAdminCache";

describe("contentSuperAdminCache", () => {
  beforeEach(() => {
    clearContentSuperAdminCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearContentSuperAdminCache();
  });

  it("stores cache without inventing admin role when contentRole omitted", () => {
    writeContentSuperAdminCache("user-1");
    const cached = readContentSuperAdminCache();
    expect(cached?.userId).toBe("user-1");
    expect(cached?.contentRole).toBeUndefined();
  });

  it("expires stale cache entries after TTL", () => {
    writeContentSuperAdminCache("user-1", "admin");
    vi.advanceTimersByTime(CONTENT_SUPER_ADMIN_CACHE_TTL_MS + 1);
    expect(readContentSuperAdminCache()).toBeNull();
  });

  it("keeps fresh cache entries within TTL", () => {
    writeContentSuperAdminCache("user-1", "editor");
    vi.advanceTimersByTime(CONTENT_SUPER_ADMIN_CACHE_TTL_MS - 1000);
    expect(readContentSuperAdminCache()?.contentRole).toBe("editor");
  });
});

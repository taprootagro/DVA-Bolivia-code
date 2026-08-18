import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readNativePhotoToDataUrl } from "../capacitor-bridge";

describe("readNativePhotoToDataUrl", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    (window as any).Capacitor = undefined;
    (window as any).__CAP_PLUGINS__ = undefined;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it("returns dataUrl when provided", async () => {
    const result = await readNativePhotoToDataUrl({
      dataUrl: "data:image/png;base64,abc",
    });
    expect(result).toBe("data:image/png;base64,abc");
  });

  it("wraps base64 as jpeg data URL", async () => {
    const result = await readNativePhotoToDataUrl({ base64: "YWJj" });
    expect(result).toBe("data:image/jpeg;base64,YWJj");
  });

  it("does not double-wrap base64 that is already a data URL", async () => {
    const result = await readNativePhotoToDataUrl({
      base64: "data:image/png;base64,YWJj",
    });
    expect(result).toBe("data:image/png;base64,YWJj");
  });

  it("passes through webPath that is already data URL", async () => {
    const data = "data:image/webp;base64,UklGRg==";
    const result = await readNativePhotoToDataUrl({ webPath: data });
    expect(result).toBe(data);
  });

  it("fetches https webPath and returns blob data URL", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      blob: async () => blob,
    } as Response);

    const result = await readNativePhotoToDataUrl({
      webPath: "https://cdn.example.com/photo.jpg",
    });
    expect(result).toMatch(/^data:image\/jpeg;base64,/);
    expect(fetch).toHaveBeenCalledWith("https://cdn.example.com/photo.jpg");
  });

  it("uses Capacitor.convertFileSrc for capacitor paths", async () => {
    const blob = new Blob([new Uint8Array([4, 5])], { type: "image/png" });
    (window as any).Capacitor = {
      convertFileSrc: (p: string) => `https://localhost/_capacitor_file_${p}`,
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      blob: async () => blob,
    } as Response);

    const result = await readNativePhotoToDataUrl({
      webPath: "capacitor://localhost/photo.png",
    });
    expect(result).toMatch(/^data:image\/png;base64,/);
    expect(fetch).toHaveBeenCalledWith(
      "https://localhost/_capacitor_file_capacitor://localhost/photo.png",
    );
  });

  it("returns null when no usable fields", async () => {
    expect(await readNativePhotoToDataUrl({})).toBeNull();
    expect(await readNativePhotoToDataUrl({ webPath: "   " })).toBeNull();
  });
});

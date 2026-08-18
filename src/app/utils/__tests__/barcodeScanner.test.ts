import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { barcodeScanner } from "../capacitor-bridge";

function nativePlugin(overrides: Record<string, unknown> = {}) {
  (window as any).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
  };
  const plugin = {
    checkPermission: vi.fn(async () => ({ granted: true })),
    hideBackground: vi.fn(async () => undefined),
    showBackground: vi.fn(async () => undefined),
    startScan: vi.fn(async () => {
      expect(document.documentElement.classList.contains("qr-scanner-active")).toBe(true);
      expect(document.body.classList.contains("qr-scanner-active")).toBe(true);
      return { hasContent: true, content: "https://example.com", format: "QR_CODE" };
    }),
    stopScan: vi.fn(async () => undefined),
    enableTorch: vi.fn(async () => undefined),
    disableTorch: vi.fn(async () => undefined),
    ...overrides,
  };
  (window as any).__CAP_PLUGINS__ = {
    "@capacitor-community/barcode-scanner": { BarcodeScanner: plugin },
  };
  return plugin;
}

describe("barcodeScanner", () => {
  beforeEach(() => {
    (window as any).Capacitor = undefined;
    (window as any).__CAP_PLUGINS__ = undefined;
    document.documentElement.classList.remove("qr-scanner-active");
    document.body.classList.remove("qr-scanner-active");
  });

  afterEach(() => {
    (window as any).Capacitor = undefined;
    (window as any).__CAP_PLUGINS__ = undefined;
    document.documentElement.classList.remove("qr-scanner-active");
    document.body.classList.remove("qr-scanner-active");
  });

  it("returns unavailable on web", async () => {
    expect(await barcodeScanner.scan()).toEqual({ status: "unavailable" });
  });

  it("hides WebView background before startScan and restores after", async () => {
    const plugin = nativePlugin();
    const result = await barcodeScanner.scan();

    expect(plugin.hideBackground).toHaveBeenCalled();
    expect(plugin.startScan).toHaveBeenCalled();
    expect(plugin.hideBackground.mock.invocationCallOrder[0]).toBeLessThan(
      plugin.startScan.mock.invocationCallOrder[0],
    );
    expect(plugin.showBackground).toHaveBeenCalled();
    expect(result).toEqual({
      status: "content",
      content: "https://example.com",
      format: "QR_CODE",
    });
    expect(document.documentElement.classList.contains("qr-scanner-active")).toBe(false);
  });

  it("returns denied without hideBackground when permission is rejected", async () => {
    const plugin = nativePlugin({
      checkPermission: vi.fn(async () => ({ granted: false })),
    });
    const result = await barcodeScanner.scan();
    expect(result).toEqual({ status: "denied" });
    expect(plugin.hideBackground).not.toHaveBeenCalled();
    expect(plugin.startScan).not.toHaveBeenCalled();
  });

  it("calls onPreviewReady after hideBackground and before startScan", async () => {
    const order: string[] = [];
    const plugin = nativePlugin({
      hideBackground: vi.fn(async () => {
        order.push("hideBackground");
      }),
      startScan: vi.fn(async () => {
        order.push("startScan");
        return { hasContent: false };
      }),
    });

    await barcodeScanner.scan({
      onPreviewReady: () => {
        order.push("onPreviewReady");
      },
    });

    expect(order).toEqual(["hideBackground", "onPreviewReady", "startScan"]);
    expect(plugin.hideBackground).toHaveBeenCalled();
    expect(plugin.startScan).toHaveBeenCalled();
  });

  it("skips startScan when hideBackground is missing so the UI can fall back", async () => {
    const plugin = nativePlugin({ hideBackground: undefined });
    const result = await barcodeScanner.scan();
    expect(result).toEqual({ status: "unavailable" });
    expect(plugin.startScan).not.toHaveBeenCalled();
  });

  it("stopScan restores opaque WebView", async () => {
    const plugin = nativePlugin();
    document.documentElement.classList.add("qr-scanner-active");
    await barcodeScanner.stopScan();
    expect(plugin.stopScan).toHaveBeenCalled();
    expect(plugin.showBackground).toHaveBeenCalled();
    expect(document.documentElement.classList.contains("qr-scanner-active")).toBe(false);
  });
});

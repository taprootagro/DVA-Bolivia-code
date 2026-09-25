import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { barcodeScanner } from "../capacitor-bridge";

function nativePlugin(overrides: Record<string, unknown> = {}) {
  (window as any).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
  };
  const plugin = {
    scanBarcode: vi.fn(async () => ({
      ScanResult: "https://example.com",
      format: 0,
    })),
    ...overrides,
  };
  (window as any).__CAP_PLUGINS__ = {
    "@capacitor/barcode-scanner": { CapacitorBarcodeScanner: plugin },
  };
  return plugin;
}

describe("barcodeScanner", () => {
  beforeEach(() => {
    (window as any).Capacitor = undefined;
    (window as any).__CAP_PLUGINS__ = undefined;
  });

  afterEach(() => {
    (window as any).Capacitor = undefined;
    (window as any).__CAP_PLUGINS__ = undefined;
  });

  it("returns unavailable on web", async () => {
    expect(await barcodeScanner.scan()).toEqual({ status: "unavailable" });
  });

  it("opens native scanner and returns decoded content", async () => {
    const plugin = nativePlugin();
    const result = await barcodeScanner.scan();

    expect(plugin.scanBarcode).toHaveBeenCalledWith({
      hint: 0,
      scanButton: false,
      scanInstructions: " ",
      scanText: " ",
      cameraDirection: 1,
      scanOrientation: 3,
      android: { scanningLibrary: "mlkit" },
    });
    expect(result).toEqual({
      status: "content",
      content: "https://example.com",
      format: "0",
    });
  });

  it("returns denied when native scanner reports permission error", async () => {
    nativePlugin({
      scanBarcode: vi.fn(async () => {
        throw new Error("Camera permission denied");
      }),
    });
    const result = await barcodeScanner.scan();
    expect(result).toEqual({ status: "denied" });
  });

  it("returns empty when user cancels native scanner", async () => {
    nativePlugin({
      scanBarcode: vi.fn(async () => {
        throw new Error("User cancelled scan");
      }),
    });
    const result = await barcodeScanner.scan();
    expect(result).toEqual({ status: "empty" });
  });

  it("calls onPreviewReady before scanBarcode", async () => {
    const order: string[] = [];
    const plugin = nativePlugin({
      scanBarcode: vi.fn(async () => {
        order.push("scanBarcode");
        return { ScanResult: "", format: 0 };
      }),
    });

    await barcodeScanner.scan({
      onPreviewReady: () => {
        order.push("onPreviewReady");
      },
    });

    expect(order).toEqual(["onPreviewReady", "scanBarcode"]);
    expect(plugin.scanBarcode).toHaveBeenCalled();
  });

  it("returns unavailable when scanBarcode is missing", async () => {
    (window as any).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    };
    (window as any).__CAP_PLUGINS__ = {
      "@capacitor/barcode-scanner": { CapacitorBarcodeScanner: {} },
    };
    const result = await barcodeScanner.scan();
    expect(result).toEqual({ status: "unavailable" });
  });

  it("stopScan is a no-op for official plugin", async () => {
    await expect(barcodeScanner.stopScan()).resolves.toBeUndefined();
  });

  it("setTorch returns false (native UI handles torch)", async () => {
    nativePlugin();
    expect(await barcodeScanner.setTorch(true)).toBe(false);
  });
});

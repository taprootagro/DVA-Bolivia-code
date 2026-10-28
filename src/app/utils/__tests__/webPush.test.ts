import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolvePushApiBase, unbindWebPush } from "../webPush";

const DEFAULT_BASE = "https://api-bolivia.dva-agro.com/functions/v1/server";

describe("resolvePushApiBase", () => {
  const bp = { supabaseUrl: "https://abc.supabase.co/", edgeFunctionName: "server" };

  it("prefers webpush.pushApiBase when it is a full Edge path", () => {
    expect(
      resolvePushApiBase({
        pushProvidersConfig: { webpush: { pushApiBase: "https://push.example.org/functions/v1/server/" } },
        pushConfig: { pushApiBase: "https://other.example.org/functions/v1/server" },
        backendProxyConfig: bp,
      }),
    ).toBe("https://push.example.org/functions/v1/server");
  });

  it("derives from backendProxyConfig for bare hosts, placeholders and empty values", () => {
    const derived = "https://abc.supabase.co/functions/v1/server";
    expect(resolvePushApiBase({ pushConfig: { pushApiBase: "https://bare.example.org" }, backendProxyConfig: bp })).toBe(derived);
    expect(resolvePushApiBase({ pushConfig: { pushApiBase: "https://api.example.com" }, backendProxyConfig: bp })).toBe(derived);
    expect(resolvePushApiBase({ backendProxyConfig: bp })).toBe(derived);
    expect(resolvePushApiBase({})).toBe("");
  });
});

describe("unbindWebPush", () => {
  const unsubscribe = vi.fn(async () => true);
  const fetchMock = vi.fn();

  function installServiceWorker(sub: { endpoint: string; unsubscribe: typeof unsubscribe } | null) {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: vi.fn(async () => ({
          pushManager: { getSubscription: vi.fn(async () => sub) },
        })),
      },
    });
  }

  beforeEach(() => {
    localStorage.clear();
    unsubscribe.mockClear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  });

  it("does nothing without a service worker or subscription", async () => {
    const getToken = vi.fn(async () => "jwt");
    await unbindWebPush(getToken);
    installServiceWorker(null);
    await unbindWebPush(getToken);
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes the backend row with the session token, then the browser subscription", async () => {
    installServiceWorker({ endpoint: "https://push.example/ep-1", unsubscribe });
    await unbindWebPush(async () => "jwt-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_BASE}/push/unsubscribe`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
    expect(JSON.parse(String(init.body))).toEqual({ endpoint: "https://push.example/ep-1" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(unsubscribe.mock.invocationCallOrder[0]);
  });

  it("still unsubscribes locally when there is no token or the backend call fails", async () => {
    installServiceWorker({ endpoint: "https://push.example/ep-2", unsubscribe });
    await unbindWebPush(async () => null);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await unbindWebPush(async () => "jwt");
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("does not stall logout on a hanging backend call", async () => {
    vi.useFakeTimers();
    try {
      installServiceWorker({ endpoint: "https://push.example/ep-3", unsubscribe });
      fetchMock.mockImplementationOnce(() => new Promise(() => {}));
      const done = unbindWebPush(async () => "jwt");
      await vi.advanceTimersByTimeAsync(2500);
      await done;
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

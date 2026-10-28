import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CONFIG_STORAGE_KEY } from "../../constants";

vi.mock("../../utils/auth", () => ({
  ensureEdgeSessionReadyDetailed: vi.fn(async () => ({ token: "user-jwt", failureKind: null })),
  syncAccessTokenFromSupabaseSession: vi.fn(async () => {}),
}));

vi.mock("../../utils/supabaseBrowser", () => ({
  getSupabaseBrowserClient: vi.fn(() => null),
}));

import {
  cloudAIService,
  getCloudAIHealth,
  AI_PROVIDER_MISCONFIGURED,
  UPSTREAM_BUSY,
  buildCloudAiHistory,
} from "../CloudAIService";
import { cloudAIGuard } from "../../utils/cloudAIGuard";

function writeBackendConfig(maxTokens = 512, edgeFunctionName = "ai-vision-proxy"): void {
  localStorage.setItem(
    CONFIG_STORAGE_KEY,
    JSON.stringify({
      cloudAIConfig: { enabled: true, edgeFunctionName, modelId: "qwen-max", maxTokens },
      backendProxyConfig: {
        enabled: true,
        supabaseUrl: "https://example.supabase.co",
        supabaseAnonKey: "anon-key",
      },
    }),
  );
  window.dispatchEvent(new CustomEvent("configUpdate"));
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CloudAIService error mapping", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    writeBackendConfig();
    cloudAIGuard.updateConfig({ cooldownSeconds: 0 });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["PROVIDER_AUTH", "PROVIDER_CONFIG"])(
    "maps 502 %s to AI_PROVIDER_MISCONFIGURED",
    async (code) => {
      fetchMock.mockResolvedValue(jsonResponse({ error: code }, 502));
      await expect(cloudAIService.followUp("hello", "previous")).rejects.toThrow(
        AI_PROVIDER_MISCONFIGURED,
      );
    },
  );

  it("keeps 503 UPSTREAM_BUSY as a retryable busy error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "UPSTREAM_BUSY", retry_after_seconds: 15 }, 503));
    await expect(cloudAIService.followUp("hello", "previous")).rejects.toThrow(UPSTREAM_BUSY);
  });

  it("does not send modelId; the Edge function picks the model from app_config", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ analysis: "ok", provider: "qwen", model: "qwen-max" }, 200));
    await expect(cloudAIService.followUp("hello", "previous")).resolves.toBe("ok");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.supabase.co/functions/v1/ai-vision-proxy");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).not.toHaveProperty("modelId");
    expect(body.maxTokens).toBe(512);
    expect((init as RequestInit).headers).toMatchObject({ Accept: "text/event-stream" });
  });

  it("sends structured history and previousAnalysis separately", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ analysis: "ok" }, 200));
    await cloudAIService.followUp("next?", "first diagnosis", "en", {
      history: [{ role: "user", content: "how to spray?" }, { role: "assistant", content: "use X" }],
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.previousAnalysis).toBe("first diagnosis");
    expect(body.userMessage).toBe("next?");
    expect(body.history).toEqual([
      { role: "user", content: "how to spray?" },
      { role: "assistant", content: "use X" },
    ]);
  });

  it("reads SSE deltas and returns the final analysis", async () => {
    const sse = [
      'data: {"delta":"Hel"}\n\n',
      'data: {"delta":"lo"}\n\n',
      'data: {"done":true,"analysis":"Hello","provider":"qwen","model":"qwen-max"}\n\n',
    ].join("");
    fetchMock.mockResolvedValue(
      new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    const deltas: string[] = [];
    await expect(
      cloudAIService.followUp("hi", "prev", "en", undefined, (d) => deltas.push(d)),
    ).resolves.toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);
  });
});

describe("buildCloudAiHistory", () => {
  it("keeps the last 10 turns and clips each to 2000 chars", () => {
    const msgs = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "ai") as "user" | "ai",
      text: i === 11 ? "x".repeat(2500) : `m${i}`,
    }));
    const hist = buildCloudAiHistory(msgs);
    expect(hist).toHaveLength(10);
    expect(hist[0]).toEqual({ role: "user", content: "m2" });
    expect(hist[9].role).toBe("assistant");
    expect(hist[9].content).toHaveLength(2000);
  });
});

describe("CloudAIService merged config cache", () => {
  const fetchMock = vi.fn();
  const guardDefaults = cloudAIGuard.getConfig();

  beforeEach(() => {
    localStorage.clear();
    cloudAIGuard.updateConfig({ cooldownSeconds: 0 });
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () =>
      jsonResponse({ analysis: "ok", provider: "qwen", model: "qwen-max" }, 200),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    cloudAIGuard.updateConfig(guardDefaults);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function lastBodyMaxTokens(): number {
    const calls = fetchMock.mock.calls;
    const init = calls[calls.length - 1]![1] as RequestInit;
    return JSON.parse(String(init.body)).maxTokens;
  }

  it("reuses the merged config until configUpdate fires", async () => {
    writeBackendConfig(512);
    await cloudAIService.followUp("hello", "previous");
    expect(lastBodyMaxTokens()).toBe(512);

    const raw = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY)!);
    raw.cloudAIConfig.maxTokens = 900;
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(raw));
    await cloudAIService.followUp("hello", "previous");
    expect(lastBodyMaxTokens()).toBe(512);

    window.dispatchEvent(new CustomEvent("configUpdate"));
    await cloudAIService.followUp("hello", "previous");
    expect(lastBodyMaxTokens()).toBe(900);
  });

  it("invalidates on a cross-tab storage event for the config key", async () => {
    writeBackendConfig(512);
    await cloudAIService.followUp("hello", "previous");

    const raw = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY)!);
    raw.cloudAIConfig.maxTokens = 700;
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(raw));
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    await cloudAIService.followUp("hello", "previous");
    expect(lastBodyMaxTokens()).toBe(512);

    window.dispatchEvent(new StorageEvent("storage", { key: CONFIG_STORAGE_KEY }));
    await cloudAIService.followUp("hello", "previous");
    expect(lastBodyMaxTokens()).toBe(700);
  });
});

describe("getCloudAIHealth", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("probes <endpoint>/health once per endpoint and returns the Edge provider", async () => {
    writeBackendConfig(512, "ai-vision-proxy-health-a");
    fetchMock.mockResolvedValue(jsonResponse({ provider: "gemini", modelId: "gemini-2.0-flash", configured: true }, 200));

    await expect(getCloudAIHealth()).resolves.toEqual({
      provider: "gemini",
      modelId: "gemini-2.0-flash",
      configured: true,
    });
    await getCloudAIHealth();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://example.supabase.co/functions/v1/ai-vision-proxy-health-a/health",
    );
  });

  it("does not cache a failed probe", async () => {
    writeBackendConfig(512, "ai-vision-proxy-health-b");
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    await expect(getCloudAIHealth()).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse({ provider: "qwen", modelId: "qwen-vl-max", configured: true }, 200));
    await expect(getCloudAIHealth()).resolves.toMatchObject({ provider: "qwen" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

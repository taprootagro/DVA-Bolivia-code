import { describe, it, expect } from "vitest";
import type { HomePageConfig } from "../../../hooks/useHomeConfig";
import { patchConfigSection } from "../cmsTab";

function baseConfig(): HomePageConfig {
  return {
    cloudAIConfig: {
      enabled: true,
      providerName: "Qwen",
      edgeFunctionName: "ai-vision-proxy",
      modelId: "qwen-vl-max",
      systemPrompt: "",
      maxTokens: 512,
      clientMaxConcurrent: 40,
      clientDailyLimit: 15,
      supabaseAnonKey: "old",
    },
    aiModelConfig: { modelUrl: "https://cdn/x.onnx", labelsUrl: "", enableLocalModel: false },
  } as unknown as HomePageConfig;
}

describe("patchConfigSection", () => {
  it("keeps every other field of the patched section", () => {
    const next = patchConfigSection(baseConfig(), "cloudAIConfig", { supabaseAnonKey: "new" });
    expect(next.cloudAIConfig).toEqual({ ...baseConfig().cloudAIConfig, supabaseAnonKey: "new" });
    expect(next.cloudAIConfig.clientMaxConcurrent).toBe(40);
  });

  it("removes keys patched to undefined (leave empty = built-in default)", () => {
    const next = patchConfigSection(baseConfig(), "cloudAIConfig", { clientDailyLimit: undefined });
    expect("clientDailyLimit" in next.cloudAIConfig).toBe(false);
    expect(JSON.parse(JSON.stringify(next)).cloudAIConfig).not.toHaveProperty("clientDailyLimit");
  });

  it("leaves other sections and the input object untouched", () => {
    const input = baseConfig();
    const snapshot = JSON.parse(JSON.stringify(input));
    const next = patchConfigSection(input, "aiModelConfig", { enableLocalModel: true });
    expect(input).toEqual(snapshot);
    expect(next.cloudAIConfig).toBe(input.cloudAIConfig);
    expect(next.aiModelConfig).toEqual({ ...snapshot.aiModelConfig, enableLocalModel: true });
  });

  it("creates the section when it is missing", () => {
    const next = patchConfigSection({} as HomePageConfig, "aiModelConfig", { modelUrl: "u" });
    expect(next.aiModelConfig).toEqual({ modelUrl: "u" });
  });
});

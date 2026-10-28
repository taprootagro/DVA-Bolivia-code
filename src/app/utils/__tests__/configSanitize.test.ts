import { describe, it, expect } from "vitest";
import { redactPublicConfig } from "../../../../supabase/functions/_shared/redactPublicConfig";
import { mergeConfigEmptyStringOverwrites } from "../../../../supabase/functions/_shared/configMergeEmptyPreserve";
import { applyEditorFieldScope, EDITOR_FIELD_LIST } from "../../../../supabase/functions/_shared/editorFields";
import editorFieldsJson from "../../../../taprootagrosetting/editorFields.json";

describe("redactPublicConfig", () => {
  it("strips cloudAIConfig.systemPrompt and leaves the rest", () => {
    const out = redactPublicConfig({
      banners: [{ id: 1 }],
      cloudAIConfig: { provider: "dashscope", systemPrompt: "secret", modelId: "qwen" },
    }) as { cloudAIConfig: Record<string, unknown>; banners: unknown[] };
    expect(out.banners).toEqual([{ id: 1 }]);
    expect(out.cloudAIConfig.provider).toBe("dashscope");
    expect(out.cloudAIConfig.systemPrompt).toBeUndefined();
  });
});

describe("editorFields.json", () => {
  it("matches the Edge EDITOR_FIELD_LIST", () => {
    expect([...editorFieldsJson].sort()).toEqual([...EDITOR_FIELD_LIST].sort());
  });
});

describe("applyEditorFieldScope", () => {
  it("keeps previous admin-only keys when an editor posts a subset", () => {
    const scoped = applyEditorFieldScope(
      { banners: [{ id: 2 }], cloudAIConfig: { modelId: "hijack" } },
      { banners: [{ id: 1 }], cloudAIConfig: { modelId: "keep" } },
    );
    expect(scoped.banners).toEqual([{ id: 2 }]);
    expect(scoped.cloudAIConfig).toEqual({ modelId: "keep" });
  });
});

describe("mergeConfigEmptyStringOverwrites", () => {
  it("lets an empty string overwrite a previous media URL", () => {
    const merged = mergeConfigEmptyStringOverwrites(
      { splashScreen: { imageUrl: "" } },
      { splashScreen: { imageUrl: "https://cdn.example/old.png" } },
    ) as { splashScreen: { imageUrl: string } };
    expect(merged.splashScreen.imageUrl).toBe("");
  });
});

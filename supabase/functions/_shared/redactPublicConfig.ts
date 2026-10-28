/** Strip fields that must not leave the server for anonymous / farmer GET /config. */
export function redactPublicConfig(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const c = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const cloud = c.cloudAIConfig;
  if (cloud && typeof cloud === "object" && !Array.isArray(cloud)) {
    delete (cloud as Record<string, unknown>).systemPrompt;
  }
  return c;
}

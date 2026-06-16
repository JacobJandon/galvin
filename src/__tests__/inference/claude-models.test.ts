import { describe, it, expect } from "vitest";
import { STATIC_MODEL_BASELINE } from "../../inference/types.js";
import { ProviderRegistry } from "../../inference/provider-registry.js";

describe("Claude models in the catalog", () => {
  const byId = Object.fromEntries(STATIC_MODEL_BASELINE.map((m) => [m.modelId, m]));

  it("includes the latest Claude models on the anthropic provider with correct pricing", () => {
    // Pricing is hundredths of cents per 1k = ($ per 1M) × 10.
    const opus = byId["claude-opus-4-8"];
    expect(opus?.provider).toBe("anthropic");
    expect(opus?.costPer1kInput).toBe(50); // $5/M
    expect(opus?.costPer1kOutput).toBe(250); // $25/M
    expect(opus?.parameterStyle).toBe("max_tokens"); // Anthropic param name
    expect(opus?.supportsTools).toBe(true);

    expect(byId["claude-sonnet-4-6"]?.costPer1kInput).toBe(30); // $3/M
    expect(byId["claude-sonnet-4-6"]?.costPer1kOutput).toBe(150); // $15/M
    expect(byId["claude-haiku-4-5"]?.costPer1kInput).toBe(10); // $1/M
    expect(byId["claude-fable-5"]?.costPer1kOutput).toBe(500); // $50/M
  });
});

describe("Anthropic provider registration", () => {
  it("registers anthropic via the OpenAI-compatible endpoint with the Claude models", () => {
    const reg = ProviderRegistry.fromConfig("/nonexistent-inference-providers.json");
    const anth = reg.getProviders().find((p) => p.id === "anthropic");
    expect(anth).toBeDefined();
    expect(anth?.baseUrl).toBe("https://api.anthropic.com/v1"); // OpenAI-compat endpoint
    expect(anth?.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
    const modelIds = anth?.models.map((m) => m.id) ?? [];
    expect(modelIds).toContain("claude-opus-4-8");
    expect(modelIds).toContain("claude-sonnet-4-6");
    expect(modelIds).toContain("claude-haiku-4-5");
  });

  it("resolves claude-opus-4-8 on the anthropic provider", () => {
    const reg = ProviderRegistry.fromConfig("/nonexistent-inference-providers.json");
    reg.setEnabled("anthropic", true); // off by default; a configured key flips it on
    const resolved = reg.getModel("anthropic", "claude-opus-4-8");
    expect(resolved.provider.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(resolved.model.id).toBe("claude-opus-4-8");
  });
});

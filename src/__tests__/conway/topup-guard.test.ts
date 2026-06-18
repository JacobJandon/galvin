import { describe, it, expect } from "vitest";
import { usesConwayCredits } from "../../conway/topup.js";

describe("usesConwayCredits — never buy credits a direct provider doesn't need", () => {
  it("Claude model + Anthropic key → direct, NO Conway credits", () => {
    expect(usesConwayCredits({ inferenceModel: "claude-opus-4-8", anthropicApiKey: "sk-ant-x" })).toBe(false);
    expect(usesConwayCredits({ modelStrategy: { inferenceModel: "claude-sonnet-4-6" }, anthropicApiKey: "sk-ant-x" })).toBe(false);
  });

  it("GPT/o model + OpenAI key → direct, NO Conway credits", () => {
    expect(usesConwayCredits({ inferenceModel: "gpt-5.2", openaiApiKey: "sk-x" })).toBe(false);
    expect(usesConwayCredits({ inferenceModel: "o3", openaiApiKey: "sk-x" })).toBe(false);
  });

  it("Claude model but NO Anthropic key → routes to Conway, credits needed", () => {
    expect(usesConwayCredits({ inferenceModel: "claude-opus-4-8" })).toBe(true);
  });

  it("GPT model but NO OpenAI key → routes to Conway, credits needed", () => {
    expect(usesConwayCredits({ inferenceModel: "gpt-5.2" })).toBe(true);
  });

  it("modelStrategy takes precedence over top-level inferenceModel", () => {
    expect(usesConwayCredits({ inferenceModel: "gpt-5.2", modelStrategy: { inferenceModel: "claude-opus-4-8" }, anthropicApiKey: "k" })).toBe(false);
  });
});

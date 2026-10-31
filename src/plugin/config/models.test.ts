import { describe, expect, it } from "vitest";

import { OPENCODE_MODEL_DEFINITIONS } from "./models";

const getModel = (name: string) => {
  const model = OPENCODE_MODEL_DEFINITIONS[name];
  if (!model) {
    throw new Error(`Missing model definition for ${name}`);
  }
  return model;
};

describe("OPENCODE_MODEL_DEFINITIONS", () => {
  it("includes the full set of configured models", () => {
    const modelNames = Object.keys(OPENCODE_MODEL_DEFINITIONS).sort();

    expect(modelNames).toEqual([
      "antigravity-claude-opus-4-6-thinking",
      "antigravity-claude-opus-5-5-high",
      "antigravity-claude-opus-5-5-low",
      "antigravity-claude-opus-5-5-medium",
      "antigravity-claude-sonnet-4-6",
      "antigravity-claude-sonnet-5-5-high",
      "antigravity-claude-sonnet-5-5-low",
      "antigravity-claude-sonnet-5-5-medium",
      "antigravity-gemini-3-flash",
      "antigravity-gemini-3-pro",
      "antigravity-gemini-3.1-pro",
      "antigravity-gemini-3.5-flash-lite",
      "antigravity-gemini-3.8-flash-high",
      "antigravity-gemini-3.8-flash-low",
      "antigravity-gemini-3.8-flash-medium",
      "antigravity-gemini-4-argon-high",
      "antigravity-gemini-4-argon-low",
      "antigravity-gemini-4-argon-medium",
      "antigravity-gpt-oss-120b-medium",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools",
    ]);
  });

  it("defines the current Antigravity inventory with account catalog limits", () => {
    expect(getModel("antigravity-gemini-4-argon-high")).toMatchObject({
      name: "Gemini 4 Argon (High) (Antigravity)",
      limit: { context: 1048576, output: 65536 },
    });
    expect(getModel("antigravity-gemini-4-argon-medium").limit).toEqual({ context: 1048576, output: 65536 });
    expect(getModel("antigravity-gemini-3.5-flash-lite").limit).toEqual({ context: 1048576, output: 65535 });
    expect(getModel("antigravity-claude-opus-5-5-high").limit).toEqual({ context: 1000000, output: 128000 });
    expect(getModel("antigravity-claude-sonnet-5-5-low").limit).toEqual({ context: 1000000, output: 128000 });
    expect(getModel("antigravity-gpt-oss-120b-medium")).toMatchObject({
      limit: { context: 131072, output: 32768 },
      modalities: { input: ["text"], output: ["text"] },
    });
  });

  it("defines Gemini 3 variants for Antigravity models", () => {
    expect(getModel("antigravity-gemini-3-pro").variants).toEqual({
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" },
    });

    expect(getModel("antigravity-gemini-3.1-pro").variants).toEqual({
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" },
    });

    expect(getModel("antigravity-gemini-3-flash").variants).toEqual({
      minimal: { thinkingLevel: "minimal" },
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });
  });

  it("defines thinking budget variants for Claude thinking models", () => {
    expect(getModel("antigravity-claude-opus-4-6-thinking").variants).toEqual({
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    });
  });
});

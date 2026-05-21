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
  it("includes the current Antigravity model quota set", () => {
    const modelNames = Object.keys(OPENCODE_MODEL_DEFINITIONS).sort();

    expect(modelNames).toEqual([
      "antigravity-claude-opus-4-6-thinking",
      "antigravity-claude-sonnet-4-6",
      "antigravity-gemini-3.1-pro-high",
      "antigravity-gemini-3.1-pro-low",
      "antigravity-gemini-3.5-flash-low",
      "antigravity-gpt-oss-120b-medium",
    ]);
  });

  it("adds one direct model definition for each live quota tier returned by Antigravity", () => {
    expect(getModel("antigravity-gemini-3.1-pro-low").variants).toBeUndefined();
    expect(getModel("antigravity-gemini-3.1-pro-high").variants).toBeUndefined();
    expect(getModel("antigravity-gemini-3.5-flash-low").variants).toBeUndefined();
  });

  it("keeps single-row quota models as direct model definitions", () => {
    expect(getModel("antigravity-claude-sonnet-4-6").variants).toBeUndefined();
    expect(getModel("antigravity-claude-opus-4-6-thinking").variants).toBeUndefined();
    expect(getModel("antigravity-gpt-oss-120b-medium").variants).toBeUndefined();
  });
});

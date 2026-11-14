import { describe, expect, it } from "vitest";
import {
  OPENCODE_SIGNATURE_NEEDLE,
  OPENCODE_SIGNATURE_REPLACEMENT,
  neutralizeOpenCodePromptSignature,
} from "./prompt-signature";

describe("neutralizeOpenCodePromptSignature", () => {
  it("rewrites the OpenCode Code Mode signature in system prompt text", () => {
    const body = JSON.stringify({
      request: {
        systemInstruction: {
          role: "user",
          parts: [{ text: "Code Mode tools catalog:\n - tools.opencode.session_move({ ... })" }],
        },
      },
    });

    const neutralized = neutralizeOpenCodePromptSignature(body);

    expect(neutralized).not.toContain(OPENCODE_SIGNATURE_NEEDLE);
    expect(neutralized).toContain('tools["opencode"].session_move({ ... })');
  });

  it("rewrites every occurrence in the body", () => {
    const body = "a tools.opencode.session_move b tools.opencode.session_move c";
    const neutralized = neutralizeOpenCodePromptSignature(body);
    expect(neutralized.match(/tools\["opencode"\]\./g)?.length).toBe(2);
    expect(neutralized).not.toContain(OPENCODE_SIGNATURE_NEEDLE);
  });

  it("leaves bodies without the signature untouched", () => {
    const body = JSON.stringify({
      request: { systemInstruction: { parts: [{ text: "You are Antigravity." }] } },
    });

    expect(neutralizeOpenCodePromptSignature(body)).toBe(body);
  });

  it("handles JSON-escaped payload text (no false negatives from quoting)", () => {
    // Inside serialized JSON the tool catalog may contain escaped characters;
    // the needle itself contains none, so replacement must still apply.
    const body = '{"request":{"systemInstruction":{"parts":[{"text":"use tools.opencode.\\nsession_move docs"}]}}}';
    const neutralized = neutralizeOpenCodePromptSignature(body);
    expect(neutralized).toContain(OPENCODE_SIGNATURE_REPLACEMENT);
  });

  it("does not match variants that are already safe", () => {
    // Optional chaining / bracket access forms must not be double-rewritten.
    const body = 'tools.opencode?.session_move and tools["opencode"].worktree_list()';
    expect(neutralizeOpenCodePromptSignature(body)).toBe(body);
  });

  it("replacement output stays syntactically equivalent JavaScript for the model", () => {
    // Bracket access preserves object access semantics.
    const neutralized = neutralizeOpenCodePromptSignature("tools.opencode.session_move(x)");
    expect(neutralized).toBe('tools["opencode"].session_move(x)');
    expect(neutralized).not.toContain(OPENCODE_SIGNATURE_REPLACEMENT + OPENCODE_SIGNATURE_REPLACEMENT);
  });

  it("exports a stable needle matching the blocked substring", () => {
    expect(OPENCODE_SIGNATURE_NEEDLE).toBe("tools.opencode.");
  });
});

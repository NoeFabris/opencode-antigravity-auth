import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { AntigravityConfigSchema, DEFAULT_CONFIG } from "./schema";

describe("cli_first config", () => {
  it("includes cli_first default in DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG).toHaveProperty("cli_first", false);
  });

  it("documents cli_first in the JSON schema", () => {
    const schemaPath = new URL("../../../assets/antigravity.schema.json", import.meta.url);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      properties?: Record<string, { type?: string; default?: unknown; description?: string }>;
    };

    const cliFirst = schema.properties?.cli_first;
    expect(cliFirst).toBeDefined();
    expect(cliFirst).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(typeof cliFirst?.description).toBe("string");
    expect(cliFirst?.description?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("claude_prompt_auto_caching config", () => {
  it("includes claude_prompt_auto_caching default in DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG).toHaveProperty("claude_prompt_auto_caching", false);
  });

  it("documents claude_prompt_auto_caching in the JSON schema", () => {
    const schemaPath = new URL("../../../assets/antigravity.schema.json", import.meta.url);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      properties?: Record<string, { type?: string; default?: unknown; description?: string }>;
    };

    const claudePromptAutoCaching = schema.properties?.claude_prompt_auto_caching;
    expect(claudePromptAutoCaching).toBeDefined();
    expect(claudePromptAutoCaching).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(typeof claudePromptAutoCaching?.description).toBe("string");
    expect(claudePromptAutoCaching?.description?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("account affinity config", () => {
  it("accepts model_account_affinity values by email", () => {
    const config = AntigravityConfigSchema.parse({
      model_account_affinity: {
        "antigravity-claude-sonnet-4-6": "work@example.com",
      },
    });

    expect(config.model_account_affinity["antigravity-claude-sonnet-4-6"]).toBe("work@example.com");
  });

  it("rejects legacy account indexes in model_account_affinity", () => {
    expect(() => AntigravityConfigSchema.parse({
      model_account_affinity: {
        "antigravity-claude-sonnet-4-6": "0",
      },
    })).toThrow();
  });

  it("includes account affinity defaults in DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG).toHaveProperty("model_account_affinity", {});
    expect(DEFAULT_CONFIG).toHaveProperty("account_affinity_strict", false);
  });

  it("accepts account_affinity_strict boolean", () => {
    const config = AntigravityConfigSchema.parse({ account_affinity_strict: true });
    expect(config.account_affinity_strict).toBe(true);
  });
});

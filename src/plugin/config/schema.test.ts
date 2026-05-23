import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { AgySdkCloudProjectSchema, DEFAULT_CONFIG } from "./schema";

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

describe("agy_sdk config", () => {
  it("includes agy_sdk defaults in DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG.agy_sdk).toMatchObject({
      enabled: true,
      prefer_for_gemini: false,
      api_key_fallback: true,
      cloud_projects: [],
    });
  });

  it("documents agy_sdk in the JSON schema", () => {
    const schemaPath = new URL("../../../assets/antigravity.schema.json", import.meta.url);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      properties?: Record<string, { type?: string; default?: unknown; description?: string }>;
    };

    const agySdk = schema.properties?.agy_sdk;
    expect(agySdk).toBeDefined();
    expect(agySdk?.type).toBe("object");
  });

  it("rejects whitespace-only API keys", () => {
    expect(AgySdkCloudProjectSchema.safeParse({ api_key: "   " }).success).toBe(false);
    expect(AgySdkCloudProjectSchema.parse({ api_key: " key " }).api_key).toBe("key");
  });
});

describe("model_discovery config", () => {
  it("includes model_discovery defaults in DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG.model_discovery).toMatchObject({
      enabled: true,
      gemini_api: true,
      antigravity: true,
    });
  });
});

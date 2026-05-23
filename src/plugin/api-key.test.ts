import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAgySdkCredentials,
  fetchGeminiApiModels,
  isAgySdkSupportedRequest,
  prepareAgySdkGeminiRequest,
  selectAgySdkCredential,
  markAgySdkCredentialRateLimited,
  resetAgySdkCredentialStateForTests,
} from "./api-key";
import { DEFAULT_CONFIG, type AntigravityConfig } from "./config";

function withConfig(overrides: Partial<AntigravityConfig>): AntigravityConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    agy_sdk: {
      ...DEFAULT_CONFIG.agy_sdk,
      ...overrides.agy_sdk,
    },
  };
}

async function readPreparedBody(body: BodyInit | null | undefined): Promise<unknown> {
  if (typeof body === "string") return JSON.parse(body);
  return JSON.parse(await new Response(body).text());
}

describe("api-key agy sdk support", () => {
  beforeEach(() => {
    resetAgySdkCredentialStateForTests();
  });

  it("loads API key credentials from auth, config cloud projects, and environment", () => {
    vi.stubEnv("GEMINI_API_KEY", "env-key");
    vi.stubEnv("GOOGLE_API_KEY", "google-key");
    try {
      const credentials = getAgySdkCredentials(
        withConfig({
          agy_sdk: {
            ...DEFAULT_CONFIG.agy_sdk,
            cloud_projects: [
              { label: "backup", api_key: "config-key", project_id: "cloud-project", enabled: true },
            ],
          },
        }),
        { type: "api", key: "auth-key" },
      );

      expect(credentials).toEqual([
        { label: "opencode api key", apiKey: "auth-key" },
        { label: "backup", apiKey: "config-key", projectId: "cloud-project" },
        { label: "environment", apiKey: "env-key" },
        { label: "environment", apiKey: "google-key" },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("prepares public Gemini API requests with API key headers and no URL secret", async () => {
    const prepared = await prepareAgySdkGeminiRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3-pro-high:streamGenerateContent?alt=sse&key=old-url-key",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer oauth",
          "x-api-key": "old",
        },
        body: JSON.stringify({
          model: "ignored",
          contents: [],
          generationConfig: { temperature: 0.4 },
          providerOptions: {
            google: {
              thinkingLevel: "high",
              includeThoughts: false,
              googleSearch: { mode: "auto" },
            },
          },
        }),
      },
      { label: "backup", apiKey: "test-key", projectId: "cloud-project" },
    );

    expect(String(prepared.request)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse",
    );
    const headers = new Headers(prepared.init.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBe("test-key");
    expect(headers.get("x-goog-user-project")).toBeNull();
    expect(await readPreparedBody(prepared.init.body)).toEqual({
      contents: [],
      generationConfig: {
        temperature: 0.4,
        thinkingConfig: {
          thinkingLevel: "high",
          includeThoughts: false,
        },
      },
      tools: [{ googleSearch: {} }],
    });
  });

  it("preserves Request input method, headers, and body when routing through API-key auth", async () => {
    const original = new Request(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?key=old-url-key",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer oauth",
          "x-request-id": "request-123",
        },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      },
    );

    const prepared = await prepareAgySdkGeminiRequest(
      original,
      undefined,
      { label: "backup", apiKey: "test-key", projectId: "cloud-project" },
    );

    const headers = new Headers(prepared.init.headers);
    expect(prepared.init.method).toBe("POST");
    expect(await readPreparedBody(prepared.init.body)).toEqual({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: {
        thinkingConfig: {
          thinkingLevel: "low",
          includeThoughts: true,
        },
      },
    });
    expect(headers.get("x-request-id")).toBe("request-123");
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBe("test-key");
  });

  it("adds default Gemini 3 thinking config without dropping extra body options", async () => {
    const prepared = await prepareAgySdkGeminiRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
      {
        method: "POST",
        body: JSON.stringify({
          contents: [],
          generationConfig: {
            temperature: 0.2,
          },
          extra_body: {
            cachedContent: "cachedContents/example",
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.7,
            },
          },
        }),
      },
      { label: "env", apiKey: "test-key" },
    );

    expect(await readPreparedBody(prepared.init.body)).toEqual({
      contents: [],
      cachedContent: "cachedContents/example",
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.2,
        thinkingConfig: {
          thinkingLevel: "low",
          includeThoughts: true,
        },
      },
    });
  });

  it("keeps Gemini 3 tier suffix as thinking level while stripping it from the public API model", async () => {
    const prepared = await prepareAgySdkGeminiRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3-pro-high:generateContent",
      {
        method: "POST",
        body: JSON.stringify({ contents: [] }),
      },
      { label: "env", apiKey: "test-key" },
    );

    expect(String(prepared.request)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent",
    );
    expect(await readPreparedBody(prepared.init.body)).toEqual({
      contents: [],
      generationConfig: {
        thinkingConfig: {
          thinkingLevel: "high",
          includeThoughts: true,
        },
      },
    });
  });

  it("preserves API-native preview model names for Gemini API requests", async () => {
    const prepared = await prepareAgySdkGeminiRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent",
      {
        method: "POST",
        body: JSON.stringify({ contents: [] }),
      },
      { label: "env", apiKey: "test-key" },
    );

    expect(String(prepared.request)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent",
    );
  });

  it("skips Claude requests and rate-limited keys", () => {
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent")).toBe(true);
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent")).toBe(false);
    expect(isAgySdkSupportedRequest("https://generativelanguage.googleapis.com/v1beta/models")).toBe(false);
    expect(isAgySdkSupportedRequest("https://example.com/redirect?next=https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent")).toBe(false);

    const first = { label: "first", apiKey: "first" };
    const second = { label: "second", apiKey: "second" };
    markAgySdkCredentialRateLimited(first, 60_000);
    expect(selectAgySdkCredential([first, second])).toEqual(second);
  });

  it("resets API-key credential rotation and rate-limit state for isolated tests", () => {
    const first = { label: "first", apiKey: "first" };
    const second = { label: "second", apiKey: "second" };

    markAgySdkCredentialRateLimited(first, 60_000);
    expect(selectAgySdkCredential([first, second])).toEqual(second);

    resetAgySdkCredentialStateForTests();
    expect(selectAgySdkCredential([first, second])).toEqual(first);
  });

  it("fetches Gemini API models with API-key header and pagination", async () => {
    const requests: RequestInfo[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo, _init?: RequestInit) => {
      requests.push(input);
      const url = new URL(String(input));
      if (!url.searchParams.get("pageToken")) {
        return new Response(JSON.stringify({
          models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }],
          nextPageToken: "next",
        }));
      }
      return new Response(JSON.stringify({
        models: [{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["streamGenerateContent"] }],
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const models = await fetchGeminiApiModels({ label: "test", apiKey: "secret" });

      expect(models.map((model) => model.name)).toEqual([
        "models/gemini-2.5-flash",
        "models/gemini-2.5-pro",
      ]);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        headers: { "x-goog-api-key": "secret" },
      });
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(String(requests[0])).toContain("pageSize=1000");
      expect(String(requests[1])).toContain("pageToken=next");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops Gemini API model pagination when the service repeats a page token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      models: [],
      nextPageToken: "repeat",
    }))));

    try {
      await expect(fetchGeminiApiModels({ label: "test", apiKey: "secret" })).rejects.toThrow(
        "repeated page token",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops Gemini API model pagination after the maximum page count", async () => {
    let page = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      page += 1;
      return new Response(JSON.stringify({
        models: [],
        nextPageToken: `next-${page}`,
      }));
    }));

    try {
      await expect(fetchGeminiApiModels({ label: "test", apiKey: "secret" })).rejects.toThrow(
        "exceeded 20 pages",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

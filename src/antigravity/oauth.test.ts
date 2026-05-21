import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_OFFICIAL_REDIRECT_URI,
  ANTIGRAVITY_AUTH_ENDPOINT,
  ANTIGRAVITY_SCOPES,
} from "../constants";
import { authorizeAntigravity, exchangeAntigravity } from "./oauth";

// Mock PKCE so we control verifier/challenge in tests
vi.mock("@openauthjs/openauth/pkce", () => ({
  generatePKCE: vi.fn().mockResolvedValue({
    challenge: "test-challenge-base64url",
    verifier: "test-verifier-random-value",
  }),
}));

// Mock fetch for token exchange tests
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock logger to suppress output during tests
vi.mock("../plugin/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock auth module (calculateTokenExpiry)
vi.mock("../plugin/auth", () => ({
  calculateTokenExpiry: vi.fn((startTime, expiresIn) => startTime + expiresIn * 1000),
}));

/**
 * Helper: create a valid base64url state from verifier and project ID.
 */
function makeState(verifier: string, projectId: string): string {
  return Buffer.from(
    JSON.stringify({ verifier, projectId }),
    "utf8",
  ).toString("base64url");
}

describe("authorizeAntigravity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("local-callback mode (default)", () => {
    it("uses the v2 auth endpoint", async () => {
      const result = await authorizeAntigravity();
      const url = new URL(result.url);
      expect(url.origin + url.pathname).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
    });

    it("uses the local redirect URI", async () => {
      const result = await authorizeAntigravity();
      const url = new URL(result.url);
      expect(url.searchParams.get("redirect_uri")).toBe(ANTIGRAVITY_REDIRECT_URI);
    });

    it("includes all scopes including openid", async () => {
      const result = await authorizeAntigravity();
      const url = new URL(result.url);
      const scope = url.searchParams.get("scope")!;
      for (const s of ANTIGRAVITY_SCOPES) {
        expect(scope).toContain(s);
      }
    });

    it("includes openid in scope set", async () => {
      const result = await authorizeAntigravity();
      const url = new URL(result.url);
      const scope = url.searchParams.get("scope")!;
      expect(scope).toContain("openid");
    });

    it("uses PKCE S256", async () => {
      const result = await authorizeAntigravity();
      const url = new URL(result.url);
      expect(url.searchParams.get("code_challenge")).toBe("test-challenge-base64url");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("includes the client ID", async () => {
      const result = await authorizeAntigravity();
      const url = new URL(result.url);
      expect(url.searchParams.get("client_id")).toBe(ANTIGRAVITY_CLIENT_ID);
    });

    it("requests offline access with consent prompt", async () => {
      const result = await authorizeAntigravity();
      const url = new URL(result.url);
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("consent");
    });

    it("uses opaque state without embedding PKCE verifier", async () => {
      const result = await authorizeAntigravity("my-project-123");
      const url = new URL(result.url);
      const state = url.searchParams.get("state")!;

      expect(state).toBe(result.state);
      expect(state.length).toBeGreaterThan(20);
      expect(state).not.toContain("test-verifier-random-value");
      expect(state).not.toBe(makeState("test-verifier-random-value", "my-project-123"));
    });

    it("returns verifier matching the PKCE pair", async () => {
      const result = await authorizeAntigravity();
      expect(result.verifier).toBe("test-verifier-random-value");
    });

    it("returns empty project ID when none provided", async () => {
      const result = await authorizeAntigravity();
      expect(result.projectId).toBe("");
    });

    it("response type is code", async () => {
      const result = await authorizeAntigravity();
      const url = new URL(result.url);
      expect(url.searchParams.get("response_type")).toBe("code");
    });
  });

  describe("official-callback mode", () => {
    it("uses the v1 auth endpoint", async () => {
      const result = await authorizeAntigravity("", "official-callback");
      const url = new URL(result.url);
      expect(url.origin + url.pathname).toBe(ANTIGRAVITY_AUTH_ENDPOINT);
    });

    it("uses the official hosted redirect URI", async () => {
      const result = await authorizeAntigravity("", "official-callback");
      const url = new URL(result.url);
      expect(url.searchParams.get("redirect_uri")).toBe(
        ANTIGRAVITY_OFFICIAL_REDIRECT_URI,
      );
    });

    it("still includes openid in scope", async () => {
      const result = await authorizeAntigravity("", "official-callback");
      const url = new URL(result.url);
      const scope = url.searchParams.get("scope")!;
      expect(scope).toContain("openid");
    });

    it("still uses PKCE S256", async () => {
      const result = await authorizeAntigravity("", "official-callback");
      const url = new URL(result.url);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("still uses the same client ID", async () => {
      const result = await authorizeAntigravity("", "official-callback");
      const url = new URL(result.url);
      expect(url.searchParams.get("client_id")).toBe(ANTIGRAVITY_CLIENT_ID);
    });
  });
});

describe("exchangeAntigravity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  /**
   * Helper: create a valid base64url state from verifier and project ID.
   */
  function makeState(verifier: string, projectId: string): string {
    return Buffer.from(
      JSON.stringify({ verifier, projectId }),
      "utf8",
    ).toString("base64url");
  }  describe("local-callback mode (default)", () => {
    it("sends token exchange with local redirect URI", async () => {
      const state = makeState("verifier-abc", "proj-123");

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: "at-123",
            expires_in: 3600,
            refresh_token: "rt-456",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ email: "test@example.com" }),
        });

      await exchangeAntigravity("auth-code-xyz", state);

      // First fetch call is the token exchange
      const tokenCall = mockFetch.mock.calls[0]!;
      const body = (tokenCall[1] as RequestInit).body as URLSearchParams;
      expect(body.get("redirect_uri")).toBe(ANTIGRAVITY_REDIRECT_URI);
    });

    it("sends client_id, client_secret, code, grant_type, code_verifier", async () => {
      const state = makeState("my-verifier", "my-project");

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: "at",
            expires_in: 3600,
            refresh_token: "rt",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({}),
        });

      // Mock fetchProjectID to return empty (no third-party project discovery)
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          text: async () => "not found",
        });

      const result = await exchangeAntigravity("code-123", state);

      const tokenCall = mockFetch.mock.calls[0]!;
      const body = (tokenCall[1] as RequestInit).body as URLSearchParams;

      expect(body.get("client_id")).toBe(ANTIGRAVITY_CLIENT_ID);
      expect(body.get("code")).toBe("code-123");
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code_verifier")).toBe("my-verifier");
      expect(body.get("client_secret")).toBeTruthy();
    });

    it("returns success with stored refresh format", async () => {
      const state = makeState("v", "my-proj");

      // fetchProjectID is not called because projectId is already in state
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: "access-tok",
            expires_in: 3600,
            refresh_token: "refresh-tok",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ email: "user@test.com" }),
        });

      const result = await exchangeAntigravity("code", state);

      if (result.type !== "success") {
        throw new Error(`Expected success, got: ${result.type}${result.type === "failed" ? ` (${result.error})` : ""}`);
      }
      expect(result.refresh).toBe("refresh-tok|my-proj");
      expect(result.access).toBe("access-tok");
      expect(result.email).toBe("user@test.com");
      expect(result.projectId).toBe("my-proj");
    });

    it("returns failure when token endpoint returns non-OK", async () => {
      const state = makeState("v", "");

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"error":"invalid_grant"}',
      });

      const result = await exchangeAntigravity("bad-code", state);
      expect(result.type).toBe("failed");
      if (result.type === "failed") {
        expect(result.error).toContain("invalid_grant");
      }
    });

    it("returns failure when refresh token is missing", async () => {
      const state = makeState("v", "proj");

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: "at",
            expires_in: 3600,
            // no refresh_token
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ email: "test@test.com" }),
        });

      const result = await exchangeAntigravity("code", state);
      expect(result.type).toBe("failed");
      if (result.type === "failed") {
        expect(result.error).toContain("refresh token");
      }
    });
  });

  describe("official-callback mode", () => {
    it("sends token exchange with official redirect URI", async () => {
      const state = makeState("verifier-xyz", "proj-456");

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: "at",
            expires_in: 3600,
            refresh_token: "rt",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ email: "test@test.com" }),
        });

      await exchangeAntigravity("code", state, "official-callback");

      const tokenCall = mockFetch.mock.calls[0]!;
      const body = (tokenCall[1] as RequestInit).body as URLSearchParams;
      expect(body.get("redirect_uri")).toBe(ANTIGRAVITY_OFFICIAL_REDIRECT_URI);
    });
  });
});

describe("oauth state storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it("exchanges an opaque state created by authorizeAntigravity", async () => {
    const customProject = "gcp-project-abc-123";
    const result = await authorizeAntigravity(customProject);
    const url = new URL(result.url);
    const state = url.searchParams.get("state")!;

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "access-tok",
          expires_in: 3600,
          refresh_token: "refresh-tok",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ email: "user@test.com" }),
      });

    const exchange = await exchangeAntigravity("auth-code", state);
    const tokenCall = mockFetch.mock.calls[0]!;
    const body = (tokenCall[1] as RequestInit).body as URLSearchParams;

    expect(body.get("code_verifier")).toBe(result.verifier);
    expect(exchange.type).toBe("success");
    if (exchange.type === "success") {
      expect(exchange.projectId).toBe(customProject);
    }
  });

  it("keeps legacy base64url state exchange support", async () => {
    const state = makeState("legacy-verifier", "legacy-project");

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "access-tok",
          expires_in: 3600,
          refresh_token: "refresh-tok",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

    await exchangeAntigravity("auth-code", state);
    const tokenCall = mockFetch.mock.calls[0]!;
    const body = (tokenCall[1] as RequestInit).body as URLSearchParams;

    expect(body.get("code_verifier")).toBe("legacy-verifier");
  });

  it("returns actionable failure for unknown opaque state", async () => {
    const result = await exchangeAntigravity("auth-code", "unknown-opaque-state");
    expect(result.type).toBe("failed");
    if (result.type === "failed") {
      expect(result.error).toContain("OAuth state expired");
      expect(result.error).toContain("Restart login");
    }
  });
});

describe("error redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it("redacts code= from error messages", async () => {
    const state = makeState("v", "");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant","error_description":"Code was already redeemed","code=4/0AeoWuM-sensitive-code-here":""}',
    });

    const result = await exchangeAntigravity("bad-code", state);
    expect(result.type).toBe("failed");
    if (result.type === "failed") {
      expect(result.error).not.toContain("4/0AeoWuM-sensitive-code-here");
      expect(result.error).toContain("[REDACTED]");
    }
  });

  it("redacts access_token from error response body", async () => {
    const state = makeState("v", "");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid_token","access_token":"ya29.secret-access-token"}',
    });

    const result = await exchangeAntigravity("code", state);
    expect(result.type).toBe("failed");
    if (result.type === "failed") {
      expect(result.error).not.toContain("ya29.secret-access-token");
      expect(result.error).toContain("[REDACTED]");
    }
  });

  it("redacts refresh_token from error response body", async () => {
    const state = makeState("v", "");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant","refresh_token":"1//secret-refresh-token"}',
    });

    const result = await exchangeAntigravity("code", state);
    expect(result.type).toBe("failed");
    if (result.type === "failed") {
      expect(result.error).not.toContain("1//secret-refresh-token");
      expect(result.error).toContain("[REDACTED]");
    }
  });

  it("redacts state, id_token, client_secret, and query tokens", async () => {
    const state = makeState("v", "");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant","state":"opaque-state-secret","id_token":"id-secret","client_secret":"client-secret","details":"access_token=query-access&refresh_token=query-refresh&state=query-state"}',
    });

    const result = await exchangeAntigravity("code", state);
    expect(result.type).toBe("failed");
    if (result.type === "failed") {
      expect(result.error).not.toContain("opaque-state-secret");
      expect(result.error).not.toContain("id-secret");
      expect(result.error).not.toContain("client-secret");
      expect(result.error).not.toContain("query-access");
      expect(result.error).not.toContain("query-refresh");
      expect(result.error).not.toContain("query-state");
      expect(result.error).toContain("[REDACTED]");
    }
  });

  it("preserves non-sensitive error information", async () => {
    const state = makeState("v", "");

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
    });

    const result = await exchangeAntigravity("code", state);
    expect(result.type).toBe("failed");
    if (result.type === "failed") {
      expect(result.error).toContain("invalid_grant");
      expect(result.error).toContain("Token has been expired or revoked");
    }
  });
});

describe("constants consistency", () => {
  it("ANTIGRAVITY_SCOPES includes openid", () => {
    expect(ANTIGRAVITY_SCOPES).toContain("openid");
  });

  it("ANTIGRAVITY_SCOPES has 6 entries (5 original + openid)", () => {
    expect(ANTIGRAVITY_SCOPES).toHaveLength(6);
  });

  it("local redirect URI is localhost", () => {
    expect(ANTIGRAVITY_REDIRECT_URI).toMatch(/^http:\/\/localhost:\d+\//);
  });

  it("official redirect URI is antigravity.google", () => {
    expect(ANTIGRAVITY_OFFICIAL_REDIRECT_URI).toBe(
      "https://antigravity.google/oauth-callback",
    );
  });

  it("auth endpoint is v1", () => {
    expect(ANTIGRAVITY_AUTH_ENDPOINT).toBe(
      "https://accounts.google.com/o/oauth2/auth",
    );
  });
});

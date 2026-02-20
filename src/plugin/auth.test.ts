import { beforeEach, describe, expect, it, vi } from "vitest";

import { isOAuthAuth, parseRefreshParts, formatRefreshParts, accessTokenExpired } from "./auth";
import type { OAuthAuthDetails, ApiKeyAuthDetails } from "./types";

describe("isOAuthAuth", () => {
  it("returns true for oauth auth type", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token|project",
      access: "access-token",
      expires: Date.now() + 3600000,
    };
    expect(isOAuthAuth(auth)).toBe(true);
  });

  it("returns false for api_key auth type", () => {
    const auth: ApiKeyAuthDetails = {
      type: "api_key",
      key: "some-api-key",
    };
    expect(isOAuthAuth(auth)).toBe(false);
  });

  it("returns false for undefined auth without throwing", () => {
    expect(isOAuthAuth(undefined)).toBe(false);
  });

  it("returns false for null auth without throwing", () => {
    expect(isOAuthAuth(null)).toBe(false);
  });
});

describe("parseRefreshParts", () => {
  it("parses refresh token with all parts", () => {
    const result = parseRefreshParts("refreshToken|projectId|managedProjectId");
    expect(result).toEqual({
      refreshToken: "refreshToken",
      projectId: "projectId",
      managedProjectId: "managedProjectId",
    });
  });

  it("parses refresh token with only refresh and project", () => {
    const result = parseRefreshParts("refreshToken|projectId");
    expect(result).toEqual({
      refreshToken: "refreshToken",
      projectId: "projectId",
      managedProjectId: undefined,
    });
  });

  it("parses refresh token with only refresh token", () => {
    const result = parseRefreshParts("refreshToken");
    expect(result).toEqual({
      refreshToken: "refreshToken",
      projectId: undefined,
      managedProjectId: undefined,
    });
  });

  it("handles empty string", () => {
    const result = parseRefreshParts("");
    expect(result).toEqual({
      refreshToken: "",
      projectId: undefined,
      managedProjectId: undefined,
    });
  });

  it("handles empty parts", () => {
    const result = parseRefreshParts("refreshToken||managedProjectId");
    expect(result).toEqual({
      refreshToken: "refreshToken",
      projectId: undefined,
      managedProjectId: "managedProjectId",
    });
  });

  it("handles undefined/null-like input", () => {
    // @ts-expect-error - testing edge case
    const result = parseRefreshParts(undefined);
    expect(result).toEqual({
      refreshToken: "",
      projectId: undefined,
      managedProjectId: undefined,
    });
  });
});

describe("formatRefreshParts", () => {
  it("formats all parts", () => {
    const result = formatRefreshParts({
      refreshToken: "refreshToken",
      projectId: "projectId",
      managedProjectId: "managedProjectId",
    });
    expect(result).toBe("refreshToken|projectId|managedProjectId");
  });

  it("formats without managed project id", () => {
    const result = formatRefreshParts({
      refreshToken: "refreshToken",
      projectId: "projectId",
    });
    expect(result).toBe("refreshToken|projectId");
  });

  it("formats without project id but with managed project id", () => {
    const result = formatRefreshParts({
      refreshToken: "refreshToken",
      managedProjectId: "managedProjectId",
    });
    expect(result).toBe("refreshToken||managedProjectId");
  });

  it("formats with only refresh token", () => {
    const result = formatRefreshParts({
      refreshToken: "refreshToken",
    });
    expect(result).toBe("refreshToken|");
  });

  it("round-trips correctly with parseRefreshParts", () => {
    const original = {
      refreshToken: "rt123",
      projectId: "proj456",
      managedProjectId: "managed789",
    };
    const formatted = formatRefreshParts(original);
    const parsed = parseRefreshParts(formatted);
    expect(parsed).toEqual(original);
  });
});

describe("accessTokenExpired", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("returns true when access token is missing", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: undefined,
      expires: Date.now() + 3600000,
    };
    expect(accessTokenExpired(auth)).toBe(true);
  });

  it("returns true when expires is missing", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: "access-token",
      expires: undefined,
    };
    expect(accessTokenExpired(auth)).toBe(true);
  });

  it("returns true when token is expired", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: "access-token",
      expires: Date.now() - 1000, // expired 1 second ago
    };
    expect(accessTokenExpired(auth)).toBe(true);
  });

  it("returns true when token expires within buffer period (60 seconds)", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: "access-token",
      expires: Date.now() + 30000, // expires in 30 seconds (within 60s buffer)
    };
    expect(accessTokenExpired(auth)).toBe(true);
  });

  it("returns false when token is valid and outside buffer period", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: "access-token",
      expires: Date.now() + 120000, // expires in 2 minutes
    };
    expect(accessTokenExpired(auth)).toBe(false);
  });

  it("returns false when token expires exactly at buffer boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: "access-token",
      expires: 60001, // expires 60001ms from now, just outside 60s buffer
    };
    expect(accessTokenExpired(auth)).toBe(false);
  });
});

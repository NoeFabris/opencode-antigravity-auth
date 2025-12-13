import { beforeEach, describe, expect, it, vi } from "vitest";

import { ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { refreshAccessToken } from "./token";
import type { OAuthAuthDetails, PluginClient } from "./types";

vi.mock("../constants", async () => {
  const actual = await vi.importActual("../constants");
  return {
    ...actual,
    ANTIGRAVITY_CLIENT_SECRET: "mock-secret",
  };
});

const baseAuth: OAuthAuthDetails = {
  type: "oauth",
  refresh: "refresh-token|project-123",
  access: "old-access",
  expires: Date.now() - 1000,
};

function createClient() {
  return {
    auth: {
      set: vi.fn(async () => {}),
    },
  } as PluginClient & {
    auth: { set: ReturnType<typeof vi.fn> };
  };
}

describe("refreshAccessToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("updates the caller and persists when refresh token is unchanged", async () => {
    const client = createClient();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);

    expect(result?.access).toBe("new-access");
    expect(client.auth.set.mock.calls.length).toBe(1);
  });

  it("persists when Google rotates the refresh token", async () => {
    const client = createClient();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "next-access",
          expires_in: 3600,
          refresh_token: "rotated-token",
        }),
        { status: 200 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);

    expect(result?.access).toBe("next-access");
    expect(client.auth.set.mock.calls.length).toBe(1);
    expect(client.auth.set.mock.calls[0]?.[0]).toEqual({
      path: { id: ANTIGRAVITY_PROVIDER_ID },
      body: expect.objectContaining({
        type: "oauth",
        refresh: expect.stringContaining("rotated-token"),
      }),
    });
  });
});

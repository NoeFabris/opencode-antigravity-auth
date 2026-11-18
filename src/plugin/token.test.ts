import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { AntigravityTokenRefreshError, refreshAccessToken } from "./token";
import type { OAuthAuthDetails, PluginClient } from "./types";

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

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("updates the caller when refresh token is unchanged", async () => {
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
    expect(client.auth.set.mock.calls.length).toBe(0);
  });

  it("handles Google refresh token rotation", async () => {
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
    expect(result?.refresh).toContain("rotated-token");
    expect(client.auth.set.mock.calls.length).toBe(0);
  });

  it("throws a typed error on invalid_grant", async () => {
    const client = createClient();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Refresh token revoked",
        }),
        { status: 400, statusText: "Bad Request" },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID)).rejects.toMatchObject({
      name: "AntigravityTokenRefreshError",
      code: "invalid_grant",
    });
  });

  it("shares concurrent rotations and retains each caller's project context", async () => {
    const client = createClient();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchMock = vi.fn(async () => {
      await gate;
      return Response.json({ access_token: "shared-access", refresh_token: "shared-rotation", expires_in: 3600 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const first = refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);
    const second = refreshAccessToken({ ...baseAuth, refresh: "refresh-token|other-project|managed" }, client, ANTIGRAVITY_PROVIDER_ID);
    release();
    const results = await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(results[0]?.refresh).toBe("shared-rotation|project-123");
    expect(results[1]?.refresh).toBe("shared-rotation|other-project|managed");
  });

  it("returns a completed rotation while its previous token is still being persisted", async () => {
    const client = createClient();
    const fetchMock = vi.fn(async () => Response.json({ access_token: "shared-access", refresh_token: "shared-rotation", expires_in: 3600 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);
    const latest = await refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);
    expect(latest?.refresh).toBe("shared-rotation|project-123");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("times out refreshAccessToken and aborts its request signal when the response body stalls", async () => {
    vi.useFakeTimers();
    const client = createClient();
    let capturedSignal: AbortSignal | undefined;
    let bodyReadStarted = false;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          pull() {
            bodyReadStarted = true;
          },
        }, { highWaterMark: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }));

    const pending = refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);
    await vi.waitFor(() => expect(bodyReadStarted).toBe(true));
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toBeUndefined();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from "../constants";
import { formatRefreshParts, parseRefreshParts, calculateTokenExpiry } from "./auth";
import { clearCachedAuth, storeCachedAuth } from "./cache";
import { createLogger } from "./logger";
import { invalidateProjectContextCache } from "./project";
import type { OAuthAuthDetails, PluginClient, RefreshParts } from "./types";

const log = createLogger("token");

interface OAuthErrorPayload {
  error?:
    | string
    | {
        code?: string;
        status?: string;
        message?: string;
      };
  error_description?: string;
}

/**
 * Parses OAuth error payloads returned by Google token endpoints, tolerating varied shapes.
 */
function parseOAuthErrorPayload(text: string | undefined): { code?: string; description?: string } {
  if (!text) {
    return {};
  }

  try {
    const payload = JSON.parse(text) as OAuthErrorPayload;
    if (!payload || typeof payload !== "object") {
      return { description: text };
    }

    let code: string | undefined;
    if (typeof payload.error === "string") {
      code = payload.error;
    } else if (payload.error && typeof payload.error === "object") {
      code = payload.error.status ?? payload.error.code;
      if (!payload.error_description && payload.error.message) {
        return { code, description: payload.error.message };
      }
    }

    const description = payload.error_description;
    if (description) {
      return { code, description };
    }

    if (payload.error && typeof payload.error === "object" && payload.error.message) {
      return { code, description: payload.error.message };
    }

    return { code };
  } catch {
    return { description: text };
  }
}

export class AntigravityTokenRefreshError extends Error {
  code?: string;
  description?: string;
  status: number;
  statusText: string;

  constructor(options: {
    message: string;
    code?: string;
    description?: string;
    status: number;
    statusText: string;
  }) {
    super(options.message);
    this.name = "AntigravityTokenRefreshError";
    this.code = options.code;
    this.description = options.description;
    this.status = options.status;
    this.statusText = options.statusText;
  }
}

interface RefreshState {
  pending: Map<string, Promise<OAuthAuthDetails | undefined>>;
  rotated: Map<string, OAuthAuthDetails>;
}

const refreshStates = new WeakMap<PluginClient, RefreshState>();

/** Share rotations across native auth, transport, discovery, and quota checks. */
export async function refreshAccessToken(
  auth: OAuthAuthDetails,
  client: PluginClient,
  providerId: string,
): Promise<OAuthAuthDetails | undefined> {
  const token = parseRefreshParts(auth.refresh).refreshToken;
  if (!token) return undefined;
  let state = refreshStates.get(client);
  if (!state) {
    state = { pending: new Map(), rotated: new Map() };
    refreshStates.set(client, state);
  }
  const key = `${providerId}:${token}`;
  const cached = state.rotated.get(key);
  if (cached && (cached.expires ?? 0) <= Date.now() + 60_000) state.rotated.delete(key);
  let refreshed = state.rotated.get(key);
  if (!refreshed) {
    let pending = state.pending.get(key);
    if (!pending) {
      pending = requestAccessToken(auth);
      state.pending.set(key, pending);
    }
    try {
      refreshed = await pending;
      if (refreshed && parseRefreshParts(refreshed.refresh).refreshToken !== token) {
        state.rotated.set(key, refreshed);
        if (state.rotated.size > 128) state.rotated.delete(state.rotated.keys().next().value!);
      }
    } finally {
      if (state.pending.get(key) === pending) state.pending.delete(key);
    }
  }
  if (!refreshed) return undefined;
  // Project context belongs to the caller, even when OAuth work is shared.
  return { ...auth, access: refreshed.access, expires: refreshed.expires, refresh: formatRefreshParts({
    ...parseRefreshParts(auth.refresh),
    refreshToken: parseRefreshParts(refreshed.refresh).refreshToken,
  }) };
}

const TOKEN_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Executes an OAuth token request and reads its response body under a single deadline.
 */
async function fetchTokenWithDeadline<T>(
  url: string,
  options: RequestInit,
  readBody: (response: Response) => Promise<T>,
  timeoutMs = TOKEN_REFRESH_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(controller.signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const timeout = setTimeout(
    () => controller.abort(new DOMException(`Token refresh timed out after ${timeoutMs}ms`, "TimeoutError")),
    timeoutMs,
  );
  const task = (async () => {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return await readBody(response);
  })();
  void task.catch(() => undefined);
  void abortPromise.catch(() => undefined);
  try {
    return await Promise.race([task, abortPromise]);
  } finally {
    clearTimeout(timeout);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Exchanges a stored OAuth refresh token for a fresh access token.
 */
async function requestAccessToken(auth: OAuthAuthDetails): Promise<OAuthAuthDetails | undefined> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  try {
    const startTime = Date.now();
    const outcome = await fetchTokenWithDeadline(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: parts.refreshToken,
          client_id: ANTIGRAVITY_CLIENT_ID,
          client_secret: ANTIGRAVITY_CLIENT_SECRET,
        }),
      },
      async (response) => {
        if (!response.ok) {
          let errorText: string | undefined;
          try {
            errorText = await response.text();
          } catch {
            errorText = undefined;
          }
          return {
            ok: false as const,
            status: response.status,
            statusText: response.statusText,
            errorText,
          };
        }

        const payload = (await response.json()) as {
          access_token: string;
          expires_in: number;
          refresh_token?: string;
        };
        return { ok: true as const, payload };
      },
    );

    if (!outcome.ok) {
      const { code, description } = parseOAuthErrorPayload(outcome.errorText);
      const details = [code, description ?? outcome.errorText].filter(Boolean).join(": ");
      const baseMessage = `Antigravity token refresh failed (${outcome.status} ${outcome.statusText})`;
      const message = details ? `${baseMessage} - ${details}` : baseMessage;
      log.warn("Token refresh failed", { status: outcome.status, code, details });

      if (code === "invalid_grant") {
        log.warn("Google revoked the stored refresh token - reauthentication required");
        invalidateProjectContextCache(auth.refresh);
        clearCachedAuth(auth.refresh);
      }

      throw new AntigravityTokenRefreshError({
        message,
        code,
        description: description ?? outcome.errorText,
        status: outcome.status,
        statusText: outcome.statusText,
      });
    }

    const payload = outcome.payload;

    const refreshedParts: RefreshParts = {
      refreshToken: payload.refresh_token ?? parts.refreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId,
    };

    const updatedAuth: OAuthAuthDetails = {
      ...auth,
      access: payload.access_token,
      expires: calculateTokenExpiry(startTime, payload.expires_in),
      refresh: formatRefreshParts(refreshedParts),
    };

    storeCachedAuth(updatedAuth);
    invalidateProjectContextCache(auth.refresh);

    return updatedAuth;
  } catch (error) {
    if (error instanceof AntigravityTokenRefreshError) {
      throw error;
    }
    log.error("Unexpected token refresh error", { error: String(error) });
    return undefined;
  }
}


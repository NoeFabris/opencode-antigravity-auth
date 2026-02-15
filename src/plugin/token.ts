import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from "../constants";
import { formatRefreshParts, parseRefreshParts, calculateTokenExpiry } from "./auth";
import { clearCachedAuth, storeCachedAuth } from "./cache";
import { createLogger } from "./logger";
import { invalidateProjectContextCache } from "./project";
import { fetchWithProxy } from "./proxy";
import type { OAuthAuthDetails, PluginClient, RefreshParts } from "./types";
import type { ProxyConfig } from "./storage";

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

/**
 * Refreshes an Antigravity OAuth access token, updates persisted credentials, and handles revocation.
 */
export async function refreshAccessToken(
  auth: OAuthAuthDetails,
  client: PluginClient,
  providerId: string,
  proxies?: ProxyConfig[],
  accountIndex?: number,
): Promise<OAuthAuthDetails | undefined> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  try {
    const startTime = Date.now();
    const response = await fetchWithProxy("https://oauth2.googleapis.com/token", {
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
    }, proxies, accountIndex);

    if (!response.ok) {
      let errorText: string | undefined;
      try {
        errorText = await response.text();
      } catch {
        errorText = undefined;
      }

      const { code, description } = parseOAuthErrorPayload(errorText);
      const details = [code, description ?? errorText].filter(Boolean).join(": ");
      const baseMessage = `Antigravity token refresh failed (${response.status} ${response.statusText})`;
      const message = details ? `${baseMessage} - ${details}` : baseMessage;
      log.warn("Token refresh failed", { status: response.status, code, details });

      if (code === "invalid_grant") {
        log.warn("Google revoked the stored refresh token - reauthentication required");
        invalidateProjectContextCache(auth.refresh);
        clearCachedAuth(auth.refresh);
      }

      throw new AntigravityTokenRefreshError({
        message,
        code,
        description: description ?? errorText,
        status: response.status,
        statusText: response.statusText,
      });
    }

    const payload = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

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


import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_PROVIDER_ID,
} from "../constants";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import { clearCachedAuth, storeCachedAuth } from "./cache";
import { invalidateProjectContextCache } from "./project";
import type { OAuthAuthDetails, PluginClient, RefreshParts } from "./types";

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

/**
 * Refreshes an Antigravity OAuth access token, updates persisted credentials, and handles revocation.
 */
export async function refreshAccessToken(
  auth: OAuthAuthDetails,
  client: PluginClient,
  providerId: string,
): Promise<OAuthAuthDetails | undefined> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  if (!ANTIGRAVITY_CLIENT_SECRET) {
    console.error("[Antigravity OAuth] Missing ANTIGRAVITY_CLIENT_SECRET environment variable");
    return undefined;
  }

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
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
    });

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
      console.warn(`[Antigravity OAuth] ${details ? `${baseMessage} - ${details}` : baseMessage}`);

      if (code === "invalid_grant") {
        console.warn(
          "[Antigravity OAuth] Google revoked the stored refresh token. Run `opencode auth login` and reauthenticate the Google provider.",
        );
        invalidateProjectContextCache(auth.refresh);
        try {
          const clearedAuth: OAuthAuthDetails = {
            type: "oauth",
            refresh: formatRefreshParts({
              refreshToken: "",
              projectId: parts.projectId,
              managedProjectId: parts.managedProjectId,
            }),
          };
          await client.auth.set({
            path: { id: providerId },
            body: clearedAuth,
          });
        } catch (storeError) {
          console.error("Failed to clear stored Antigravity OAuth credentials:", storeError);
        }
      }

      return undefined;
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
      expires: Date.now() + payload.expires_in * 1000,
      refresh: formatRefreshParts(refreshedParts),
    };

    storeCachedAuth(updatedAuth);
    invalidateProjectContextCache(auth.refresh);

    try {
      await client.auth.set({
        path: { id: providerId },
        body: updatedAuth,
      });
    } catch (storeError) {
      console.error("Failed to persist refreshed Antigravity OAuth credentials:", storeError);
    }

    return updatedAuth;
  } catch (error) {
    console.error("Failed to refresh Antigravity access token due to an unexpected error:", error);
    return undefined;
  }
}


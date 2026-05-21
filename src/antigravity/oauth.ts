import { randomBytes } from "node:crypto";

import { generatePKCE } from "@openauthjs/openauth/pkce";

import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_LOAD_ENDPOINTS,
  getAntigravityHeaders,
  GEMINI_CLI_HEADERS,
  getRedirectUri,
  getAuthEndpoint,
} from "../constants";
import type { AntigravityRedirectMode } from "../constants";
import { createLogger } from "../plugin/logger";
import { calculateTokenExpiry } from "../plugin/auth";

const log = createLogger("oauth");

/**
 * Redact sensitive OAuth values from a string before logging or surfacing as an error.
 * Removes authorization codes, PKCE verifiers, access/refresh tokens, and callback URLs
 * containing `code=` to prevent accidental credential leakage.
 */
function redactOAuthSensitiveData(input: string): string {
  return input
    // Authorization codes as query/body params (?code= or &code=)
    .replace(/([?&]code=)[^&\s"']+/gi, "$1[REDACTED]")
    // OAuth state as query/body params. State is now opaque, but still sensitive enough to redact.
    .replace(/([?&]state=)[^&\s"']+/gi, "$1[REDACTED]")
    // Authorization codes as JSON keys ("code=...":"...")
    .replace(/"code=[^"]*"(\s*:\s*"[^"]*")?/gi, '"code=[REDACTED]"')
    // Authorization codes as JSON fields
    .replace(/"code"\s*:\s*"[^"]+"/gi, '"code":"[REDACTED]"')
    // OAuth state as JSON fields
    .replace(/"state"\s*:\s*"[^"]+"/gi, '"state":"[REDACTED]"')
    // Refresh tokens (common patterns in JSON error bodies)
    .replace(/"refresh_token"\s*:\s*"[^"]+"/gi, '"refresh_token":"[REDACTED]"')
    .replace(/(refresh_token=)[^&\s"']+/gi, "$1[REDACTED]")
    // Access tokens
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[REDACTED]"')
    .replace(/(access_token=)[^&\s"']+/gi, "$1[REDACTED]")
    // ID tokens and client secrets
    .replace(/"id_token"\s*:\s*"[^"]+"/gi, '"id_token":"[REDACTED]"')
    .replace(/(id_token=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/"client_secret"\s*:\s*"[^"]+"/gi, '"client_secret":"[REDACTED]"')
    .replace(/(client_secret=)[^&\s"']+/gi, "$1[REDACTED]")
    // Bearer tokens in Authorization headers
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[REDACTED]")
    // PKCE verifiers (code_verifier= query/body param)
    .replace(/(code_verifier=)[^&\s"']+/gi, "$1[REDACTED]")
    // PKCE challenges (code_challenge= query param)
    .replace(/(code_challenge=)[^&\s"']+/gi, "$1[REDACTED]");
}

interface PkcePair {
  challenge: string;
  verifier: string;
}

interface AntigravityAuthState {
  verifier: string;
  projectId: string;
}

interface StoredOAuthState extends AntigravityAuthState {
  redirectMode: AntigravityRedirectMode;
  expiresAt: number;
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const oauthStates = new Map<string, StoredOAuthState>();

/**
 * Result returned to the caller after constructing an OAuth authorization URL.
 */
export interface AntigravityAuthorization {
  url: string;
  state: string;
  verifier: string;
  projectId: string;
  expiresAt: number;
}

interface AntigravityTokenExchangeSuccess {
  type: "success";
  refresh: string;
  access: string;
  expires: number;
  email?: string;
  projectId: string;
}

interface AntigravityTokenExchangeFailure {
  type: "failed";
  error: string;
}

export type AntigravityTokenExchangeResult =
  | AntigravityTokenExchangeSuccess
  | AntigravityTokenExchangeFailure;

interface AntigravityTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

interface AntigravityUserInfo {
  email?: string;
}

/**
 * Encode an object into a URL-safe base64 string.
 */
function encodeState(payload: AntigravityAuthState): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decode an OAuth state parameter back into its structured representation.
 */
function decodeState(state: string): AntigravityAuthState {
  const normalized = state.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  const json = Buffer.from(padded, "base64").toString("utf8");
  const parsed = JSON.parse(json);
  if (typeof parsed.verifier !== "string") {
    throw new Error("Missing PKCE verifier in state");
  }
  return {
    verifier: parsed.verifier,
    projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
  };
}

function pruneExpiredOAuthStates(now = Date.now()): void {
  for (const [state, stored] of oauthStates) {
    if (stored.expiresAt <= now) {
      oauthStates.delete(state);
    }
  }
}

function createOpaqueOAuthState(
  verifier: string,
  projectId: string,
  redirectMode: AntigravityRedirectMode,
): { state: string; expiresAt: number } {
  pruneExpiredOAuthStates();
  const state = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + OAUTH_STATE_TTL_MS;
  oauthStates.set(state, {
    verifier,
    projectId,
    redirectMode,
    expiresAt,
  });
  return { state, expiresAt };
}

function resolveOAuthState(
  state: string,
  redirectMode: AntigravityRedirectMode,
): AntigravityAuthState {
  pruneExpiredOAuthStates();

  const stored = oauthStates.get(state);
  if (stored) {
    oauthStates.delete(state);
    if (stored.redirectMode !== redirectMode) {
      throw new Error("OAuth redirect mode mismatch. Restart login and try again.");
    }
    return {
      verifier: stored.verifier,
      projectId: stored.projectId,
    };
  }

  // Legacy compatibility: older generated URLs embedded verifier/projectId in state.
  try {
    return decodeState(state);
  } catch {
    throw new Error(
      "OAuth state expired or was not generated by this plugin process. Restart login and try again.",
    );
  }
}

/**
 * Build the Antigravity OAuth authorization URL including PKCE and optional project metadata.
 *
 * @param projectId - Optional GCP project ID to embed in the OAuth state.
 * @param redirectMode - Which redirect URI and auth endpoint to use.
 *   Defaults to `"local-callback"` (existing behavior).
 */
export async function authorizeAntigravity(
  projectId = "",
  redirectMode: AntigravityRedirectMode = "local-callback",
): Promise<AntigravityAuthorization> {
  const pkce = (await generatePKCE()) as PkcePair;
  const { state, expiresAt } = createOpaqueOAuthState(
    pkce.verifier,
    projectId || "",
    redirectMode,
  );

  const url = new URL(getAuthEndpoint(redirectMode));
  url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", getRedirectUri(redirectMode));
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");

  return {
    url: url.toString(),
    state,
    verifier: pkce.verifier,
    projectId: projectId || "",
    expiresAt,
  };
}

const FETCH_TIMEOUT_MS = 10000;

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchProjectID(accessToken: string): Promise<string> {
  const errors: string[] = [];
  const loadHeaders: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": GEMINI_CLI_HEADERS["User-Agent"],
    "Client-Metadata": getAntigravityHeaders()["Client-Metadata"],
  };

  const loadEndpoints = Array.from(
    new Set<string>([...ANTIGRAVITY_LOAD_ENDPOINTS, ...ANTIGRAVITY_ENDPOINT_FALLBACKS]),
  );

  for (const baseEndpoint of loadEndpoints) {
    try {
      const url = `${baseEndpoint}/v1internal:loadCodeAssist`;
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: loadHeaders,
        body: JSON.stringify({
          metadata: {
            ideType: "ANTIGRAVITY",
            platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
            pluginType: "GEMINI",
          },
        }),
      });

      if (!response.ok) {
        const message = await response.text().catch(() => "");
        errors.push(
          `loadCodeAssist ${response.status} at ${baseEndpoint}${
            message ? `: ${message}` : ""
          }`,
        );
        continue;
      }

      const data = await response.json();
      if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
        return data.cloudaicompanionProject;
      }
      if (
        data.cloudaicompanionProject &&
        typeof data.cloudaicompanionProject.id === "string" &&
        data.cloudaicompanionProject.id
      ) {
        return data.cloudaicompanionProject.id;
      }

      errors.push(`loadCodeAssist missing project id at ${baseEndpoint}`);
    } catch (e) {
      errors.push(
        `loadCodeAssist error at ${baseEndpoint}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  if (errors.length) {
    log.warn("Failed to resolve Antigravity project via loadCodeAssist", { errors: errors.join("; ") });
  }
  return "";
}

/**
 * Exchange an authorization code for Antigravity CLI access and refresh tokens.
 *
 * @param code - Authorization code from the OAuth callback.
 * @param state - Encoded state parameter containing the PKCE verifier and project ID.
 * @param redirectMode - Which redirect URI was used during authorization.
 *   Must match the mode used in `authorizeAntigravity`. Defaults to `"local-callback"`.
 */
export async function exchangeAntigravity(
  code: string,
  state: string,
  redirectMode: AntigravityRedirectMode = "local-callback",
): Promise<AntigravityTokenExchangeResult> {
  try {
    const { verifier, projectId } = resolveOAuthState(state, redirectMode);

    const startTime = Date.now();
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": GEMINI_CLI_HEADERS["User-Agent"],
      },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: getRedirectUri(redirectMode),
        code_verifier: verifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return { type: "failed", error: redactOAuthSensitiveData(errorText) };
    }

    const tokenPayload = (await tokenResponse.json()) as AntigravityTokenResponse;

    const userInfoResponse = await fetch(
      "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
      {
        headers: {
          Authorization: `Bearer ${tokenPayload.access_token}`,
          "User-Agent": GEMINI_CLI_HEADERS["User-Agent"],
        },
      },
    );

    const userInfo = userInfoResponse.ok
      ? ((await userInfoResponse.json()) as AntigravityUserInfo)
      : {};

    const refreshToken = tokenPayload.refresh_token;
    if (!refreshToken) {
      return { type: "failed", error: "Missing refresh token in response" };
    }

    let effectiveProjectId = projectId;
    if (!effectiveProjectId) {
      effectiveProjectId = await fetchProjectID(tokenPayload.access_token);
    }

    const storedRefresh = `${refreshToken}|${effectiveProjectId || ""}`;

    return {
      type: "success",
      refresh: storedRefresh,
      access: tokenPayload.access_token,
      expires: calculateTokenExpiry(startTime, tokenPayload.expires_in),
      email: userInfo.email,
      projectId: effectiveProjectId || "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      type: "failed",
      error: redactOAuthSensitiveData(message),
    };
  }
}

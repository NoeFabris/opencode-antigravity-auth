import { exec } from "node:child_process";
import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_REDIRECT_URI,
} from "./constants";
import { authorizeAntigravity, exchangeAntigravity } from "./antigravity/oauth";
import type { AntigravityTokenExchangeResult } from "./antigravity/oauth";
import { accessTokenExpired, isOAuthAuth } from "./plugin/auth";
import { promptProjectId } from "./plugin/cli";
import { ensureProjectContext } from "./plugin/project";
import { startAntigravityDebugRequest } from "./plugin/debug";
import {
  isGenerativeLanguageRequest,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from "./plugin/request";
import { refreshAccessToken } from "./plugin/token";
import { startOAuthListener, type OAuthListener } from "./plugin/server";
import type {
  GetAuth,
  LoaderResult,
  PluginContext,
  PluginResult,
  ProjectContextResult,
  Provider,
} from "./plugin/types";

/**
 * Creates an Antigravity OAuth plugin for a specific provider ID.
 */
export const createAntigravityPlugin = (providerId: string) => async (
  { client }: PluginContext,
): Promise<PluginResult> => {
  // Optimization: Keep track of the last working endpoint to avoid redundant failures
  let preferredEndpoint: string | null = null;

  return {
    auth: {
      provider: providerId,
      loader: async (getAuth: GetAuth, provider: Provider): Promise<LoaderResult | null> => {
        const auth = await getAuth();
        if (!isOAuthAuth(auth)) {
          return null;
        }

        if (provider.models) {
          for (const model of Object.values(provider.models)) {
            if (model) {
              model.cost = { input: 0, output: 0 };
            }
          }
        }

        return {
          apiKey: "",
          async fetch(input, init) {
            // If the request is for the *other* provider, we might still want to intercept if URL matches
            // But strict compliance means we only handle requests if the auth provider matches.
            // Since loader is instantiated per provider, we are good.

            if (!isGenerativeLanguageRequest(input)) {
              return fetch(input, init);
            }

            const latestAuth = await getAuth();
            if (!isOAuthAuth(latestAuth)) {
              return fetch(input, init);
            }

            let authRecord = latestAuth;
            if (accessTokenExpired(authRecord)) {
              const refreshed = await refreshAccessToken(authRecord, client, providerId);
              if (!refreshed) {
                return fetch(input, init);
              }
              authRecord = refreshed;
            }

            const accessToken = authRecord.access;
            if (!accessToken) {
              return fetch(input, init);
            }

            /**
             * Ensures we have a usable project context for the current auth snapshot.
             */
            async function resolveProjectContext(): Promise<ProjectContextResult> {
              try {
                return await ensureProjectContext(authRecord, client, providerId);
              } catch (error) {
                throw error;
              }
            }

            const projectContext = await resolveProjectContext();

            // Endpoint fallback logic: try daily → autopush → prod
            // Optimization: Prioritize preferredEndpoint if set
            const endpointsToTry: string[] = [...ANTIGRAVITY_ENDPOINT_FALLBACKS];
            if (preferredEndpoint) {
              const index = endpointsToTry.indexOf(preferredEndpoint);
              if (index > -1) {
                endpointsToTry.splice(index, 1);
                endpointsToTry.unshift(preferredEndpoint);
              }
            }

            let lastError: Error | null = null;
            let lastResponse: Response | null = null;

            for (let i = 0; i < endpointsToTry.length; i++) {
              const currentEndpoint = endpointsToTry[i];
              if (!currentEndpoint) continue;
              
              try {
                const {
                  request,
                  init: transformedInit,
                  streaming,
                  requestedModel,
                  effectiveModel,
                  projectId: usedProjectId,
                  endpoint: usedEndpoint,
                  toolDebugMissing,
                  toolDebugSummary,
                  toolDebugPayload,
                } = prepareAntigravityRequest(
                  input,
                  init,
                  accessToken,
                  projectContext.effectiveProjectId,
                  currentEndpoint,
                );

                const originalUrl = toUrlString(input);
                const resolvedUrl = toUrlString(request);
                const debugContext = startAntigravityDebugRequest({
                  originalUrl,
                  resolvedUrl,
                  method: transformedInit.method,
                  headers: transformedInit.headers,
                  body: transformedInit.body,
                  streaming,
                  projectId: projectContext.effectiveProjectId,
                });

                const response = await fetch(request, transformedInit);

                // Check if we should retry with next endpoint
                const shouldRetry = (
                  response.status === 403 || // Forbidden
                  response.status === 404 || // Not Found
                  response.status === 429 || // Rate Limit
                  response.status >= 500     // Server errors
                );

                if (shouldRetry && i < endpointsToTry.length - 1) {
                  // Try next endpoint
                  lastResponse = response;
                  continue;
                }

                // Success or final attempt
                if (!shouldRetry) {
                   preferredEndpoint = currentEndpoint;
                }

                return transformAntigravityResponse(
                  response,
                  streaming,
                  debugContext,
                  requestedModel,
                  usedProjectId,
                  usedEndpoint,
                  effectiveModel,
                  toolDebugMissing,
                  toolDebugSummary,
                  toolDebugPayload,
                );
              } catch (error) {
                // Network error or other exception
                if (i < endpointsToTry.length - 1) {
                  lastError = error instanceof Error ? error : new Error(String(error));
                  continue;
                }

                // Final attempt failed, throw the error
                throw error;
              }
            }

            throw lastError || new Error("All Antigravity endpoints failed");
          },
        };
      },
      methods: [
        {
          label: "OAuth with Google (Antigravity)",
          type: "oauth",
          authorize: async () => {

            const isHeadless = !!(
              process.env.SSH_CONNECTION ||
              process.env.SSH_CLIENT ||
              process.env.SSH_TTY ||
              process.env.OPENCODE_HEADLESS
            );

            let listener: OAuthListener | null = null;
            if (!isHeadless) {
              try {
                listener = await startOAuthListener();
              } catch (error) {
                console.log("\nWarning: Couldn't start the local callback listener. Falling back to manual copy/paste.");
              }
            }

            const authorization = await authorizeAntigravity("");

            // Try to open the browser automatically
            if (!isHeadless) {
              try {
                if (process.platform === "darwin") {
                  exec(`open "${authorization.url}"`);
                } else if (process.platform === "win32") {
                  exec(`start "${authorization.url}"`);
                } else {
                  exec(`xdg-open "${authorization.url}"`);
                }
              } catch (e) {
                console.log("Could not open browser automatically. Please Copy/Paste the URL below.");
              }
            }

            if (listener) {
               const { host } = new URL(ANTIGRAVITY_REDIRECT_URI);

              return {
                url: authorization.url,
                instructions:
                  "Complete the sign-in flow in your browser. We'll automatically detect the redirect back to localhost.",
                method: "auto",
                callback: async (): Promise<AntigravityTokenExchangeResult> => {
                  try {
                    // We know listener is not null here because we checked 'if (listener)'
                    // But TS might need a check or non-null assertion if not inferable.
                    // Since we are in the if (listener) block, it is safe.
                    const callbackUrl = await listener!.waitForCallback();
                    const code = callbackUrl.searchParams.get("code");
                    const state = callbackUrl.searchParams.get("state");

                    if (!code || !state) {
                      return {
                        type: "failed",
                        error: "Missing code or state in callback URL",
                      };
                    }

                    return await exchangeAntigravity(code, state);
                  } catch (error) {
                    return {
                      type: "failed",
                      error: error instanceof Error ? error.message : "Unknown error",
                    };
                  } finally {
                    try {
                      await listener?.close();
                    } catch {
                    }
                  }
                },
              };
            }

            return {
              url: authorization.url,
              instructions:
                "Paste the full redirected URL (e.g., http://localhost:8085/oauth2callback?code=...): ",
              method: "code",
              callback: async (callbackUrl: string): Promise<AntigravityTokenExchangeResult> => {
                try {
                  const url = new URL(callbackUrl);
                  const code = url.searchParams.get("code");
                  const state = url.searchParams.get("state");

                  if (!code || !state) {
                    return {
                      type: "failed",
                      error: "Missing code or state in callback URL",
                    };
                  }

                  return exchangeAntigravity(code, state);
                } catch (error) {
                  return {
                    type: "failed",
                    error: error instanceof Error ? error.message : "Unknown error",
                  };
                }
              },
            };
          },
        },
        {
          provider: providerId,
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  };
};

export const AntigravityCLIOAuthPlugin = createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID);
export const GoogleOAuthPlugin = AntigravityCLIOAuthPlugin;

function toUrlString(value: RequestInfo): string {
  if (typeof value === "string") {
    return value;
  }
  const candidate = (value as Request).url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}

import {
  getAntigravityHeaders,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_LOAD_ENDPOINTS,
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
} from "../constants";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import { createLogger } from "./logger";
import type { OAuthAuthDetails, ProjectContextResult } from "./types";

const log = createLogger("project");

const projectContextResultCache = new Map<string, ProjectContextResult>();
const projectContextPendingCache = new Map<string, Promise<ProjectContextResult>>();

const CODE_ASSIST_METADATA = {
  ideType: "ANTIGRAVITY",
  platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
  pluginType: "GEMINI",
} as const;

interface AntigravityUserTier {
  id?: string;
  isDefault?: boolean;
  userDefinedCloudaicompanionProject?: boolean;
}

interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string | { id?: string };
  currentTier?: {
    id?: string;
  };
  allowedTiers?: AntigravityUserTier[];
}

interface OnboardUserPayload {
  done?: boolean;
  response?: {
    cloudaicompanionProject?: {
      id?: string;
    };
  };
}

function buildMetadata(projectId?: string): Record<string, string> {
  const metadata: Record<string, string> = {
    ideType: CODE_ASSIST_METADATA.ideType,
    platform: CODE_ASSIST_METADATA.platform,
    pluginType: CODE_ASSIST_METADATA.pluginType,
  };
  if (projectId) {
    metadata.duetProject = projectId;
  }
  return metadata;
}

/**
 * Selects the default tier ID from the allowed tiers list.
 */
function getDefaultTierId(allowedTiers?: AntigravityUserTier[]): string | undefined {
  if (!allowedTiers || allowedTiers.length === 0) {
    return undefined;
  }
  for (const tier of allowedTiers) {
    if (tier?.isDefault) {
      return tier.id;
    }
  }
  return allowedTiers[0]?.id;
}

/**
 * Promise-based delay utility.
 */
function wait(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * Extracts the cloudaicompanion project id from loadCodeAssist responses.
 */
function extractManagedProjectId(payload: LoadCodeAssistPayload | null): string | undefined {
  if (!payload) {
    return undefined;
  }
  if (typeof payload.cloudaicompanionProject === "string") {
    return payload.cloudaicompanionProject;
  }
  if (payload.cloudaicompanionProject && typeof payload.cloudaicompanionProject.id === "string") {
    return payload.cloudaicompanionProject.id;
  }
  return undefined;
}

/**
 * Generates a cache key for project context based on refresh token.
 */
function getCacheKey(auth: OAuthAuthDetails): string | undefined {
  const refresh = auth.refresh?.trim();
  return refresh ? refresh : undefined;
}

/**
 * Clears cached project context results and pending promises, globally or for a refresh key.
 */
export function invalidateProjectContextCache(refresh?: string): void {
  if (!refresh) {
    projectContextPendingCache.clear();
    projectContextResultCache.clear();
    return;
  }
  projectContextPendingCache.delete(refresh);
  projectContextResultCache.delete(refresh);
}

/**
 * Loads managed project information for the given access token and optional project.
 */
export async function loadManagedProject(
  accessToken: string,
  projectId?: string,
): Promise<LoadCodeAssistPayload | null> {
  const metadata = buildMetadata(projectId);
  const requestBody: Record<string, unknown> = { metadata };

  const loadHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "google-api-nodejs-client/9.15.1",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": getAntigravityHeaders()["Client-Metadata"],
  };

  const loadEndpoints = Array.from(
    new Set<string>([...ANTIGRAVITY_LOAD_ENDPOINTS, ...ANTIGRAVITY_ENDPOINT_FALLBACKS]),
  );

  for (const baseEndpoint of loadEndpoints) {
    try {
      const response = await fetch(
        `${baseEndpoint}/v1internal:loadCodeAssist`,
        {
          method: "POST",
          headers: loadHeaders,
          body: JSON.stringify(requestBody),
        },
      );

      if (!response.ok) {
        continue;
      }

      return (await response.json()) as LoadCodeAssistPayload;
    } catch (error) {
      log.debug("Failed to load managed project", { endpoint: baseEndpoint, error: String(error) });
      continue;
    }
  }

  return null;
}


/**
 * Onboards a managed project for the user, optionally retrying until completion.
 */
export async function onboardManagedProject(
  accessToken: string,
  tierId: string,
  projectId?: string,
  attempts = 10,
  delayMs = 5000,
): Promise<string | undefined> {
  const metadata = buildMetadata(projectId);
  const requestBody: Record<string, unknown> = {
    tierId,
    metadata,
  };

  for (const baseEndpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetch(
          `${baseEndpoint}/v1internal:onboardUser`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
              ...getAntigravityHeaders(),
            },
            body: JSON.stringify(requestBody),
          },
        );

        if (!response.ok) {
          break;
        }

        const payload = (await response.json()) as OnboardUserPayload;
        const managedProjectId = payload.response?.cloudaicompanionProject?.id;
        if (payload.done && managedProjectId) {
          return managedProjectId;
        }
        if (payload.done && projectId) {
          return projectId;
        }
      } catch (error) {
        log.debug("Failed to onboard managed project", { endpoint: baseEndpoint, error: String(error) });
        break;
      }

      await wait(delayMs);
    }
  }

  return undefined;
}

/**
 * Resolves an effective project ID for the current auth state, caching results per refresh token.
 */
export async function ensureProjectContext(auth: OAuthAuthDetails): Promise<ProjectContextResult> {
  const accessToken = auth.access;
  if (!accessToken) {
    return { auth, effectiveProjectId: "" };
  }

  const cacheKey = getCacheKey(auth);
  if (cacheKey) {
    const cached = projectContextResultCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const pending = projectContextPendingCache.get(cacheKey);
    if (pending) {
      return pending;
    }
  }

  const resolveContext = async (): Promise<ProjectContextResult> => {
    const parts = parseRefreshParts(auth.refresh);
    if (parts.managedProjectId) {
      return { auth, effectiveProjectId: parts.managedProjectId };
    }

    const fallbackProjectId = ANTIGRAVITY_DEFAULT_PROJECT_ID;
    const persistManagedProject = async (managedProjectId: string): Promise<ProjectContextResult> => {
      const updatedAuth: OAuthAuthDetails = {
        ...auth,
        refresh: formatRefreshParts({
          refreshToken: parts.refreshToken,
          projectId: parts.projectId,
          managedProjectId,
        }),
      };

      return { auth: updatedAuth, effectiveProjectId: managedProjectId };
    };

    // Try to resolve a managed project from Antigravity if possible.
    const loadPayload = await loadManagedProject(accessToken, parts.projectId ?? fallbackProjectId);
    const resolvedManagedProjectId = extractManagedProjectId(loadPayload);

    if (resolvedManagedProjectId) {
      return persistManagedProject(resolvedManagedProjectId);
    }

    // No managed project found - try to auto-provision one via onboarding.
    // This handles accounts that were added before managed project provisioning was required.
    const tierId = getDefaultTierId(loadPayload?.allowedTiers) ?? "FREE";
    log.debug("Auto-provisioning managed project", { tierId, projectId: parts.projectId });
    
    const provisionedProjectId = await onboardManagedProject(
      accessToken,
      tierId,
      parts.projectId,
    );

    if (provisionedProjectId) {
      log.debug("Successfully provisioned managed project", { provisionedProjectId });
      return persistManagedProject(provisionedProjectId);
    }

    log.warn("Failed to provision managed project - account may not work correctly", {
      hasProjectId: !!parts.projectId,
    });

    if (parts.projectId) {
      return { auth, effectiveProjectId: parts.projectId };
    }

    // No project id present in auth; fall back to the hardcoded id for requests.
    return { auth, effectiveProjectId: fallbackProjectId };
  };

  if (!cacheKey) {
    return resolveContext();
  }

  const promise = resolveContext()
    .then((result) => {
      const nextKey = getCacheKey(result.auth) ?? cacheKey;
      projectContextPendingCache.delete(cacheKey);
      projectContextResultCache.set(nextKey, result);
      if (nextKey !== cacheKey) {
        projectContextResultCache.delete(cacheKey);
      }
      return result;
    })
    .catch((error) => {
      projectContextPendingCache.delete(cacheKey);
      throw error;
    });

  projectContextPendingCache.set(cacheKey, promise);
  return promise;
}

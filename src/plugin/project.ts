import {
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_GOOG_API_CLIENT,
  getAntigravityOnboardUserAgent,
  getAntigravityUserAgent,
  getAntigravityVersion,
} from "../constants";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import { createLogger } from "./logger";
import type { OAuthAuthDetails, ProjectContextResult } from "./types";

const log = createLogger("project");

const projectContextResultCache = new Map<string, ProjectContextResult>();
const projectContextPendingCache = new Map<string, Promise<ProjectContextResult>>();

const LOAD_TIMEOUT_MS = 10000;
const ONBOARD_TIMEOUT_MS = 30000;

/** Tier used for onboarding when loadCodeAssist does not advertise one. */
const DEFAULT_TIER_ID = "free-tier";

/**
 * loadCodeAssist metadata sent by the Antigravity Hub. Platform and plugin type are
 * omitted: MACOS/WINDOWS are not valid Cloud Code platform values.
 */
const LOAD_CODE_ASSIST_METADATA = { ideType: "ANTIGRAVITY" } as const;

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
    cloudaicompanionProject?: string | { id?: string };
  };
}

/**
 * onboardUser metadata uses the snake_case control-plane fields and the Hub version.
 */
function buildOnboardMetadata(): Record<string, string> {
  return {
    ide_type: "ANTIGRAVITY",
    ide_version: getAntigravityVersion(),
    ide_name: "antigravity",
  };
}

/**
 * Selects the tier to onboard with: the default allowed tier, then the first allowed
 * tier, then the current tier, then free-tier.
 */
function getDefaultTierId(payload: LoadCodeAssistPayload | null): string {
  const allowedTiers = payload?.allowedTiers ?? [];
  for (const tier of allowedTiers) {
    if (tier?.isDefault && tier.id) {
      return tier.id;
    }
  }
  return allowedTiers[0]?.id || payload?.currentTier?.id || DEFAULT_TIER_ID;
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
 * Executes a fetch request and reads its response body under a single deadline.
 */
async function fetchWithDeadline<T>(
  url: string,
  options: RequestInit,
  readBody: (response: Response) => Promise<T>,
  timeoutMs: number,
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
    () => controller.abort(new DOMException(`Project request timed out after ${timeoutMs}ms`, "TimeoutError")),
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
 * Extracts a cloudaicompanion project id from its string or `{ id }` form.
 */
function extractProjectId(value: string | { id?: string } | undefined): string | undefined {
  const id = typeof value === "string" ? value : value?.id;
  const trimmed = typeof id === "string" ? id.trim() : "";
  return trimmed || undefined;
}

/**
 * Extracts the cloudaicompanion project id from loadCodeAssist responses.
 */
function extractManagedProjectId(payload: LoadCodeAssistPayload | null): string | undefined {
  return payload ? extractProjectId(payload.cloudaicompanionProject) : undefined;
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
 * Loads managed project information for the given access token from the Antigravity host.
 */
export async function loadManagedProject(accessToken: string): Promise<LoadCodeAssistPayload | null> {
  try {
    return await fetchWithDeadline(
      `${ANTIGRAVITY_ENDPOINT}/v1internal:loadCodeAssist`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": getAntigravityUserAgent(),
        },
        body: JSON.stringify({ metadata: LOAD_CODE_ASSIST_METADATA }),
      },
      async (response) => {
        if (!response.ok) {
          log.debug("loadCodeAssist failed", { endpoint: ANTIGRAVITY_ENDPOINT, status: response.status });
          await response.body?.cancel().catch(() => undefined);
          return null;
        }

        return (await response.json()) as LoadCodeAssistPayload;
      },
      LOAD_TIMEOUT_MS,
    );
  } catch (error) {
    log.debug("Failed to load managed project", { endpoint: ANTIGRAVITY_ENDPOINT, error: String(error) });
    return null;
  }
}


/**
 * Onboards a managed project for the user, polling until the operation completes.
 */
export async function onboardManagedProject(
  accessToken: string,
  tierId: string,
  projectId?: string,
  attempts = 10,
  delayMs = 5000,
): Promise<string | undefined> {
  const requestBody = {
    tier_id: tierId,
    metadata: buildOnboardMetadata(),
  };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const outcome = await fetchWithDeadline(
        `${ANTIGRAVITY_ENDPOINT}/v1internal:onboardUser`,
        {
          method: "POST",
          headers: {
            Accept: "*/*",
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": getAntigravityOnboardUserAgent(),
            "X-Goog-Api-Client": ANTIGRAVITY_GOOG_API_CLIENT,
          },
          body: JSON.stringify(requestBody),
        },
        async (response) => {
          if (!response.ok) {
            log.debug("onboardUser failed", { endpoint: ANTIGRAVITY_ENDPOINT, status: response.status });
            await response.body?.cancel().catch(() => undefined);
            return { stop: true as const };
          }

          return { stop: false as const, payload: (await response.json()) as OnboardUserPayload };
        },
        ONBOARD_TIMEOUT_MS,
      );

      if (outcome.stop) {
        return undefined;
      }

      if (outcome.payload.done) {
        return extractProjectId(outcome.payload.response?.cloudaicompanionProject) ?? projectId;
      }
    } catch (error) {
      log.debug("Failed to onboard managed project", { endpoint: ANTIGRAVITY_ENDPOINT, error: String(error) });
      return undefined;
    }

    if (attempt < attempts - 1) {
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
    const loadPayload = await loadManagedProject(accessToken);
    const resolvedManagedProjectId = extractManagedProjectId(loadPayload);

    if (resolvedManagedProjectId) {
      return persistManagedProject(resolvedManagedProjectId);
    }

    // No managed project found - try to auto-provision one via onboarding.
    // This handles accounts that were added before managed project provisioning was required.
    const tierId = getDefaultTierId(loadPayload);
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

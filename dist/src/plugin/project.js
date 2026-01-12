import { ANTIGRAVITY_HEADERS, ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_LOAD_ENDPOINTS, ANTIGRAVITY_DEFAULT_PROJECT_ID, } from "../constants";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import { createLogger } from "./logger";
const log = createLogger("project");
const projectContextResultCache = new Map();
const projectContextPendingCache = new Map();
const CODE_ASSIST_METADATA = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
};
class ProjectIdRequiredError extends Error {
    /**
     * Error raised when a required Google Cloud project is missing during Antigravity onboarding.
     */
    constructor() {
        super("Google Antigravity requires a Google Cloud project. Enable the Antigravity API on a project you control, rerun `opencode auth login`, and supply that project ID when prompted.");
    }
}
/**
 * Builds metadata headers required by the Code Assist API.
 */
function buildMetadata(projectId) {
    const metadata = {
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
function getDefaultTierId(allowedTiers) {
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
function wait(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}
/**
 * Extracts the cloudaicompanion project id from loadCodeAssist responses.
 */
function extractManagedProjectId(payload) {
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
function getCacheKey(auth) {
    const refresh = auth.refresh?.trim();
    return refresh ? refresh : undefined;
}
/**
 * Clears cached project context results and pending promises, globally or for a refresh key.
 */
export function invalidateProjectContextCache(refresh) {
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
export async function loadManagedProject(accessToken, projectId) {
    const metadata = buildMetadata(projectId);
    const requestBody = { metadata };
    const loadHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "google-api-nodejs-client/9.15.1",
        "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
        "Client-Metadata": ANTIGRAVITY_HEADERS["Client-Metadata"],
    };
    const loadEndpoints = Array.from(new Set([...ANTIGRAVITY_LOAD_ENDPOINTS, ...ANTIGRAVITY_ENDPOINT_FALLBACKS]));
    for (const baseEndpoint of loadEndpoints) {
        try {
            const response = await fetch(`${baseEndpoint}/v1internal:loadCodeAssist`, {
                method: "POST",
                headers: loadHeaders,
                body: JSON.stringify(requestBody),
            });
            if (!response.ok) {
                continue;
            }
            return (await response.json());
        }
        catch (error) {
            log.debug("Failed to load managed project", { endpoint: baseEndpoint, error: String(error) });
            continue;
        }
    }
    return null;
}
/**
 * Onboards a managed project for the user, optionally retrying until completion.
 */
export async function onboardManagedProject(accessToken, tierId, projectId, attempts = 10, delayMs = 5000) {
    const metadata = buildMetadata(projectId);
    const requestBody = {
        tierId,
        metadata,
    };
    if (tierId !== "FREE") {
        if (!projectId) {
            throw new ProjectIdRequiredError();
        }
        requestBody.cloudaicompanionProject = projectId;
    }
    for (const baseEndpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                const response = await fetch(`${baseEndpoint}/v1internal:onboardUser`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${accessToken}`,
                        ...ANTIGRAVITY_HEADERS,
                    },
                    body: JSON.stringify(requestBody),
                });
                if (!response.ok) {
                    break;
                }
                const payload = (await response.json());
                const managedProjectId = payload.response?.cloudaicompanionProject?.id;
                if (payload.done && managedProjectId) {
                    return managedProjectId;
                }
                if (payload.done && projectId) {
                    return projectId;
                }
            }
            catch (error) {
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
export async function ensureProjectContext(auth) {
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
    const resolveContext = async () => {
        const parts = parseRefreshParts(auth.refresh);
        if (parts.managedProjectId) {
            return { auth, effectiveProjectId: parts.managedProjectId };
        }
        const fallbackProjectId = ANTIGRAVITY_DEFAULT_PROJECT_ID;
        const persistManagedProject = async (managedProjectId) => {
            const updatedAuth = {
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
//# sourceMappingURL=project.js.map
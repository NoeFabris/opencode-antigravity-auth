import { getCachedVersion, getLocalDevVersion, findPluginEntry, getLatestVersion, updatePinnedVersion } from "./checker";
import { invalidatePackage } from "./cache";
import { PACKAGE_NAME } from "./constants";
import { debugLogToFile } from "../../plugin/debug";
function debugLog(message) {
    debugLogToFile(message);
}
export function createAutoUpdateCheckerHook(client, directory, options = {}) {
    const { showStartupToast = true, autoUpdate = true } = options;
    let hasChecked = false;
    return {
        event: ({ event }) => {
            if (event.type !== "session.created")
                return;
            if (hasChecked)
                return;
            const props = event.properties;
            if (props?.info?.parentID)
                return;
            hasChecked = true;
            setTimeout(() => {
                const localDevVersion = getLocalDevVersion(directory);
                if (localDevVersion) {
                    if (showStartupToast) {
                        showLocalDevToast(client, localDevVersion).catch(() => { });
                    }
                    debugLog("[auto-update-checker] Local development mode");
                    return;
                }
                runBackgroundUpdateCheck(client, directory, autoUpdate).catch((err) => {
                    debugLog(`[auto-update-checker] Background update check failed: ${err}`);
                });
            }, 0);
        },
    };
}
async function runBackgroundUpdateCheck(client, directory, autoUpdate) {
    const pluginInfo = findPluginEntry(directory);
    if (!pluginInfo) {
        debugLog("[auto-update-checker] Plugin not found in config");
        return;
    }
    const cachedVersion = getCachedVersion();
    const currentVersion = cachedVersion ?? pluginInfo.pinnedVersion;
    if (!currentVersion) {
        debugLog("[auto-update-checker] No version found (cached or pinned)");
        return;
    }
    if (currentVersion.includes('-')) {
        debugLog(`[auto-update-checker] Prerelease version (${currentVersion}), skipping auto-update`);
        return;
    }
    const latestVersion = await getLatestVersion();
    if (!latestVersion) {
        debugLog("[auto-update-checker] Failed to fetch latest version");
        return;
    }
    if (currentVersion === latestVersion) {
        debugLog("[auto-update-checker] Already on latest version");
        return;
    }
    debugLog(`[auto-update-checker] Update available: ${currentVersion} → ${latestVersion}`);
    if (!autoUpdate) {
        await showUpdateAvailableToast(client, latestVersion);
        debugLog("[auto-update-checker] Auto-update disabled, notification only");
        return;
    }
    if (pluginInfo.isPinned) {
        const updated = updatePinnedVersion(pluginInfo.configPath, pluginInfo.entry, latestVersion);
        if (updated) {
            invalidatePackage(PACKAGE_NAME);
            await showAutoUpdatedToast(client, currentVersion, latestVersion);
            debugLog(`[auto-update-checker] Config updated: ${pluginInfo.entry} → ${PACKAGE_NAME}@${latestVersion}`);
        }
        else {
            await showUpdateAvailableToast(client, latestVersion);
        }
    }
    else {
        invalidatePackage(PACKAGE_NAME);
        await showUpdateAvailableToast(client, latestVersion);
    }
}
async function showUpdateAvailableToast(client, latestVersion) {
    await client.tui
        .showToast({
        body: {
            title: `Antigravity Auth Update`,
            message: `v${latestVersion} available. Restart OpenCode to apply.`,
            variant: "info",
            duration: 8000,
        },
    })
        .catch(() => { });
    debugLog(`[auto-update-checker] Update available toast shown: v${latestVersion}`);
}
async function showAutoUpdatedToast(client, oldVersion, newVersion) {
    await client.tui
        .showToast({
        body: {
            title: `Antigravity Auth Updated!`,
            message: `v${oldVersion} → v${newVersion}\nRestart OpenCode to apply.`,
            variant: "success",
            duration: 8000,
        },
    })
        .catch(() => { });
    debugLog(`[auto-update-checker] Auto-updated toast shown: v${oldVersion} → v${newVersion}`);
}
async function showLocalDevToast(client, version) {
    await client.tui
        .showToast({
        body: {
            title: `Antigravity Auth ${version} (dev)`,
            message: "Running in local development mode.",
            variant: "warning",
            duration: 5000,
        },
    })
        .catch(() => { });
    debugLog(`[auto-update-checker] Local dev toast shown: v${version}`);
}
export { checkForUpdate, getCachedVersion, getLatestVersion } from "./checker";
export { invalidatePackage, invalidateCache } from "./cache";
//# sourceMappingURL=index.js.map
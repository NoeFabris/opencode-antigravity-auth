/**
 * Constants for session recovery storage paths.
 *
 * Based on oh-my-opencode/src/hooks/session-recovery/constants.ts
 */
import { join } from "node:path";
import { homedir } from "node:os";
/**
 * Get the XDG data directory for OpenCode storage.
 * Falls back to ~/.local/share on Linux/Mac, or APPDATA on Windows.
 */
function getXdgData() {
    const platform = process.platform;
    if (platform === "win32") {
        return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    }
    return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}
/**
 * Get the XDG config directory for Antigravity config.
 * Falls back to ~/.config on Linux/Mac, or APPDATA on Windows.
 */
export function getXdgConfig() {
    const platform = process.platform;
    if (platform === "win32") {
        return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    }
    return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}
/**
 * Get the Antigravity config directory.
 * Default: ~/.config/opencode/antigravity.json
 */
export function getAntigravityConfigDir() {
    return join(getXdgConfig(), "opencode");
}
export const OPENCODE_STORAGE = join(getXdgData(), "opencode", "storage");
export const MESSAGE_STORAGE = join(OPENCODE_STORAGE, "message");
export const PART_STORAGE = join(OPENCODE_STORAGE, "part");
export const THINKING_TYPES = new Set(["thinking", "redacted_thinking", "reasoning"]);
export const META_TYPES = new Set(["step-start", "step-finish"]);
export const CONTENT_TYPES = new Set(["text", "tool", "tool_use", "tool_result"]);
//# sourceMappingURL=constants.js.map
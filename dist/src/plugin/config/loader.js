/**
 * Configuration loader for opencode-antigravity-auth plugin.
 *
 * Loads config from files with environment variable overrides.
 * Priority (lowest to highest):
 * 1. Schema defaults
 * 2. User config file
 * 3. Project config file
 * 4. Environment variables
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { AccountSelectionStrategySchema, AntigravityConfigSchema, DEFAULT_CONFIG } from "./schema";
import { createLogger } from "../logger";
const log = createLogger("config");
// =============================================================================
// Path Utilities
// =============================================================================
/**
 * Get the OS-specific config directory.
 */
function getConfigDir() {
    const platform = process.platform;
    if (platform === "win32") {
        return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
    }
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(xdgConfig, "opencode");
}
/**
 * Get the user-level config file path.
 */
export function getUserConfigPath() {
    return join(getConfigDir(), "antigravity.json");
}
/**
 * Get the project-level config file path.
 */
export function getProjectConfigPath(directory) {
    return join(directory, ".opencode", "antigravity.json");
}
// =============================================================================
// Config Loading
// =============================================================================
/**
 * Load and parse a config file, returning null if not found or invalid.
 */
function loadConfigFile(path) {
    try {
        if (!existsSync(path)) {
            return null;
        }
        const content = readFileSync(path, "utf-8");
        const rawConfig = JSON.parse(content);
        // Validate with Zod (partial - we'll merge with defaults later)
        const result = AntigravityConfigSchema.partial().safeParse(rawConfig);
        if (!result.success) {
            log.warn("Config validation error", {
                path,
                issues: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", "),
            });
            return null;
        }
        return result.data;
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            log.warn("Invalid JSON in config file", { path, error: error.message });
        }
        else {
            log.warn("Failed to load config file", { path, error: String(error) });
        }
        return null;
    }
}
/**
 * Deep merge two config objects, with override taking precedence.
 */
function mergeConfigs(base, override) {
    return {
        ...base,
        ...override,
        // Deep merge signature_cache if both exist
        signature_cache: override.signature_cache
            ? {
                ...base.signature_cache,
                ...override.signature_cache,
            }
            : base.signature_cache,
    };
}
/**
 * Apply environment variable overrides to config.
 * Env vars always take precedence over config file values.
 */
function applyEnvOverrides(config) {
    const env = process.env;
    return {
        ...config,
        // OPENCODE_ANTIGRAVITY_QUIET=1
        quiet_mode: env.OPENCODE_ANTIGRAVITY_QUIET === "1" || env.OPENCODE_ANTIGRAVITY_QUIET === "true"
            ? true
            : config.quiet_mode,
        // OPENCODE_ANTIGRAVITY_DEBUG=1 or any truthy value
        debug: env.OPENCODE_ANTIGRAVITY_DEBUG
            ? env.OPENCODE_ANTIGRAVITY_DEBUG !== "0" && env.OPENCODE_ANTIGRAVITY_DEBUG !== "false"
            : config.debug,
        // OPENCODE_ANTIGRAVITY_LOG_DIR=/path/to/logs
        log_dir: env.OPENCODE_ANTIGRAVITY_LOG_DIR || config.log_dir,
        // OPENCODE_ANTIGRAVITY_KEEP_THINKING=1
        keep_thinking: env.OPENCODE_ANTIGRAVITY_KEEP_THINKING === "1" ||
            env.OPENCODE_ANTIGRAVITY_KEEP_THINKING === "true"
            ? true
            : config.keep_thinking,
        // OPENCODE_ANTIGRAVITY_SESSION_RECOVERY=0 to disable
        session_recovery: env.OPENCODE_ANTIGRAVITY_SESSION_RECOVERY === "0" ||
            env.OPENCODE_ANTIGRAVITY_SESSION_RECOVERY === "false"
            ? false
            : config.session_recovery,
        // OPENCODE_ANTIGRAVITY_AUTO_RESUME=0 to disable auto-continue after recovery
        auto_resume: env.OPENCODE_ANTIGRAVITY_AUTO_RESUME === "0" ||
            env.OPENCODE_ANTIGRAVITY_AUTO_RESUME === "false"
            ? false
            : env.OPENCODE_ANTIGRAVITY_AUTO_RESUME === "1" ||
                env.OPENCODE_ANTIGRAVITY_AUTO_RESUME === "true"
                ? true
                : config.auto_resume,
        // OPENCODE_ANTIGRAVITY_RESUME_TEXT to customize resume text
        resume_text: env.OPENCODE_ANTIGRAVITY_RESUME_TEXT || config.resume_text,
        // OPENCODE_ANTIGRAVITY_AUTO_UPDATE=0 to disable
        auto_update: env.OPENCODE_ANTIGRAVITY_AUTO_UPDATE === "0" ||
            env.OPENCODE_ANTIGRAVITY_AUTO_UPDATE === "false"
            ? false
            : config.auto_update,
        // OPENCODE_ANTIGRAVITY_ACCOUNT_SELECTION_STRATEGY=sticky|round-robin|hybrid
        account_selection_strategy: env.OPENCODE_ANTIGRAVITY_ACCOUNT_SELECTION_STRATEGY
            ? AccountSelectionStrategySchema.catch('sticky').parse(env.OPENCODE_ANTIGRAVITY_ACCOUNT_SELECTION_STRATEGY)
            : config.account_selection_strategy,
        // OPENCODE_ANTIGRAVITY_PID_OFFSET_ENABLED=1
        pid_offset_enabled: env.OPENCODE_ANTIGRAVITY_PID_OFFSET_ENABLED === "1" ||
            env.OPENCODE_ANTIGRAVITY_PID_OFFSET_ENABLED === "true"
            ? true
            : config.pid_offset_enabled,
    };
}
// =============================================================================
// Main Loader
// =============================================================================
/**
 * Load the complete configuration.
 *
 * @param directory - The project directory (for project-level config)
 * @returns Fully resolved configuration
 */
export function loadConfig(directory) {
    // Start with defaults
    let config = { ...DEFAULT_CONFIG };
    // Load user config file (if exists)
    const userConfigPath = getUserConfigPath();
    const userConfig = loadConfigFile(userConfigPath);
    if (userConfig) {
        config = mergeConfigs(config, userConfig);
    }
    // Load project config file (if exists) - overrides user config
    const projectConfigPath = getProjectConfigPath(directory);
    const projectConfig = loadConfigFile(projectConfigPath);
    if (projectConfig) {
        config = mergeConfigs(config, projectConfig);
    }
    // Apply environment variable overrides (always win)
    config = applyEnvOverrides(config);
    return config;
}
/**
 * Check if a config file exists at the given path.
 */
export function configExists(path) {
    return existsSync(path);
}
/**
 * Get the default logs directory.
 */
export function getDefaultLogsDir() {
    return join(getConfigDir(), "antigravity-logs");
}
//# sourceMappingURL=loader.js.map
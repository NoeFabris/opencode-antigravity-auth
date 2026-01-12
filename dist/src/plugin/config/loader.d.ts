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
import { type AntigravityConfig } from "./schema";
/**
 * Get the user-level config file path.
 */
export declare function getUserConfigPath(): string;
/**
 * Get the project-level config file path.
 */
export declare function getProjectConfigPath(directory: string): string;
/**
 * Load the complete configuration.
 *
 * @param directory - The project directory (for project-level config)
 * @returns Fully resolved configuration
 */
export declare function loadConfig(directory: string): AntigravityConfig;
/**
 * Check if a config file exists at the given path.
 */
export declare function configExists(path: string): boolean;
/**
 * Get the default logs directory.
 */
export declare function getDefaultLogsDir(): string;
//# sourceMappingURL=loader.d.ts.map
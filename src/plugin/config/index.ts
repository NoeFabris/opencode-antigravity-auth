/**
 * Configuration module for opencode-antigravity-auth plugin.
 * 
 * @example
 * ```typescript
 * import { loadConfig, type AntigravityConfig } from "./config";
 * 
 * const config = loadConfig(directory);
 * if (config.session_recovery) {
 *   // Enable session recovery
 * }
 * ```
 */

export {
  AntigravityConfigSchema,
  SignatureCacheConfigSchema,
  DEFAULT_CONFIG,
  type AntigravityConfig,
  type SignatureCacheConfig,
} from "./schema";

export {
  loadConfig,
  getUserConfigPath,
  getProjectConfigPath,
  getDefaultLogsDir,
  configExists,
  initRuntimeConfig,
  getKeepThinking,
} from "./loader";

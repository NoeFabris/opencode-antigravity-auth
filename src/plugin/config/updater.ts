/**
 * OpenCode configuration file updater.
 *
 * Updates ~/.config/opencode/opencode.json with plugin models.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { OPENCODE_MODEL_DEFINITIONS } from "./models";

// =============================================================================
// Types
// =============================================================================

export interface UpdateConfigResult {
  success: boolean;
  configPath: string;
  error?: string;
}

export interface OpencodeConfig {
  $schema?: string;
  plugin?: string[];
  provider?: {
    google?: {
      models?: Record<string, unknown>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface UpdateConfigOptions {
  /** Override the config file path (for testing) */
  configPath?: string;
}

// =============================================================================
// Constants
// =============================================================================

const PLUGIN_NAME = "opencode-antigravity-auth@latest";
const SCHEMA_URL = "https://opencode.ai/config.json";

/**
 * Get the opencode config directory path.
 */
export function getOpencodeConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

/**
 * Get the opencode.json config file path.
 */
export function getOpencodeConfigPath(): string {
  return join(getOpencodeConfigDir(), "opencode.json");
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Updates the opencode.json configuration file with plugin models.
 *
 * This function:
 * 1. Reads existing opencode.json (or creates default structure)
 * 2. Replaces `provider.google.models` with plugin models
 * 3. Writes back to disk with proper formatting
 *
 * Preserves:
 * - $schema and other top-level config keys
 * - Non-google provider sections
 * - Other settings within google provider (except models)
 *
 * @param options - Optional configuration (e.g., custom configPath for testing)
 * @returns UpdateConfigResult with success status and path
 */
export async function updateOpencodeConfig(
  options: UpdateConfigOptions = {}
): Promise<UpdateConfigResult> {
  const configPath = options.configPath ?? getOpencodeConfigPath();

  try {
    let config: OpencodeConfig;

    // Read existing config or create default
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      config = JSON.parse(content) as OpencodeConfig;
    } else {
      // Create default config structure
      config = {
        $schema: SCHEMA_URL,
        plugin: [],
        provider: {},
      };
    }

    // Ensure $schema is set
    if (!config.$schema) {
      config.$schema = SCHEMA_URL;
    }

    // Ensure plugin array exists and contains our plugin
    if (!Array.isArray(config.plugin)) {
      config.plugin = [];
    }

    // Check if plugin is already in the list (any version)
    const hasPlugin = config.plugin.some((p) =>
      p.includes("opencode-antigravity-auth")
    );
    if (!hasPlugin) {
      config.plugin.push(PLUGIN_NAME);
    }

    // Ensure provider.google structure exists
    if (!config.provider) {
      config.provider = {};
    }
    if (!config.provider.google) {
      config.provider.google = {};
    }

    // Replace google models with plugin models
    config.provider.google.models = { ...OPENCODE_MODEL_DEFINITIONS };

    // Ensure config directory exists
    const configDir = dirname(configPath);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    // Write config with proper formatting (2-space indent)
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    return {
      success: true,
      configPath,
    };
  } catch (error) {
    return {
      success: false,
      configPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

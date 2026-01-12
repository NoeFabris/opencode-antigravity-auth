/**
 * Configuration schema for opencode-antigravity-auth plugin.
 *
 * Config file locations (in priority order, highest wins):
 * - Project: .opencode/antigravity.json
 * - User: ~/.config/opencode/antigravity.json (Linux/Mac)
 *         %APPDATA%\opencode\antigravity.json (Windows)
 *
 * Environment variables always override config file values.
 */
import { z } from "zod";
/**
 * Account selection strategy for distributing requests across accounts.
 *
 * - `sticky` (default): Use same account until rate-limited. Preserves prompt cache.
 * - `round-robin`: Rotate to next account on every request. Maximum throughput.
 * - `hybrid`: Touch all fresh accounts first to sync reset timers, then sticky.
 */
export const AccountSelectionStrategySchema = z.enum(['sticky', 'round-robin', 'hybrid']);
/**
 * Signature cache configuration for persisting thinking block signatures to disk.
 */
export const SignatureCacheConfigSchema = z.object({
    /** Enable disk caching of signatures (default: true) */
    enabled: z.boolean().default(true),
    /** In-memory TTL in seconds (default: 3600 = 1 hour) */
    memory_ttl_seconds: z.number().min(60).max(86400).default(3600),
    /** Disk TTL in seconds (default: 172800 = 48 hours) */
    disk_ttl_seconds: z.number().min(3600).max(604800).default(172800),
    /** Background write interval in seconds (default: 60) */
    write_interval_seconds: z.number().min(10).max(600).default(60),
});
/**
 * Main configuration schema for the Antigravity OAuth plugin.
 */
export const AntigravityConfigSchema = z.object({
    /** JSON Schema reference for IDE support */
    $schema: z.string().optional(),
    // =========================================================================
    // General Settings
    // =========================================================================
    /**
     * Suppress most toast notifications (rate limit, account switching, etc.)
     * Recovery toasts are always shown regardless of this setting.
     * Env override: OPENCODE_ANTIGRAVITY_QUIET=1
     * @default false
     */
    quiet_mode: z.boolean().default(false),
    /**
     * Enable debug logging to file.
     * Env override: OPENCODE_ANTIGRAVITY_DEBUG=1
     * @default false
     */
    debug: z.boolean().default(false),
    /**
     * Custom directory for debug logs.
     * Env override: OPENCODE_ANTIGRAVITY_LOG_DIR=/path/to/logs
     * @default OS-specific config dir + "/antigravity-logs"
     */
    log_dir: z.string().optional(),
    // =========================================================================
    // Thinking Blocks
    // =========================================================================
    /**
     * Preserve thinking blocks for Claude models using signature caching.
     *
     * When false (default): Thinking blocks are stripped for reliability.
     * When true: Full context preserved, but may encounter signature errors.
     *
     * Env override: OPENCODE_ANTIGRAVITY_KEEP_THINKING=1
     * @default false
     */
    keep_thinking: z.boolean().default(false),
    // =========================================================================
    // Session Recovery
    // =========================================================================
    /**
     * Enable automatic session recovery from tool_result_missing errors.
     * When enabled, shows a toast notification when recoverable errors occur.
     *
     * @default true
     */
    session_recovery: z.boolean().default(true),
    /**
     * Automatically send a "continue" prompt after successful recovery.
     * Only applies when session_recovery is enabled.
     *
     * When false: Only shows toast notification, user must manually continue.
     * When true: Automatically sends "continue" to resume the session.
     *
     * @default true
     */
    auto_resume: z.boolean().default(true),
    /**
     * Custom text to send when auto-resuming after recovery.
     * Only used when auto_resume is enabled.
     *
     * @default "continue"
     */
    resume_text: z.string().default("continue"),
    // =========================================================================
    // Signature Caching
    // =========================================================================
    /**
     * Signature cache configuration for persisting thinking block signatures.
     * Only used when keep_thinking is enabled.
     */
    signature_cache: SignatureCacheConfigSchema.optional(),
    // =========================================================================
    // Empty Response Retry (ported from LLM-API-Key-Proxy)
    // =========================================================================
    /**
     * Maximum retry attempts when Antigravity returns an empty response.
     * Empty responses occur when no candidates/choices are returned.
     *
     * @default 4
     */
    empty_response_max_attempts: z.number().min(1).max(10).default(4),
    /**
     * Delay in milliseconds between empty response retries.
     *
     * @default 2000
     */
    empty_response_retry_delay_ms: z.number().min(500).max(10000).default(2000),
    // =========================================================================
    // Tool ID Recovery (ported from LLM-API-Key-Proxy)
    // =========================================================================
    /**
     * Enable tool ID orphan recovery.
     * When tool responses have mismatched IDs (due to context compaction),
     * attempt to match them by function name or create placeholders.
     *
     * @default true
     */
    tool_id_recovery: z.boolean().default(true),
    // =========================================================================
    // Tool Hallucination Prevention (ported from LLM-API-Key-Proxy)
    // =========================================================================
    /**
     * Enable tool hallucination prevention for Claude models.
     * When enabled, injects:
     * - Parameter signatures into tool descriptions
     * - System instruction with strict tool usage rules
     *
     * This helps prevent Claude from using parameter names from its training
     * data instead of the actual schema.
     *
     * @default true
     */
    claude_tool_hardening: z.boolean().default(true),
    // =========================================================================
    // Proactive Token Refresh (ported from LLM-API-Key-Proxy)
    // =========================================================================
    /**
     * Enable proactive background token refresh.
     * When enabled, tokens are refreshed in the background before they expire,
     * ensuring requests never block on token refresh.
     *
     * @default true
     */
    proactive_token_refresh: z.boolean().default(true),
    /**
     * Seconds before token expiry to trigger proactive refresh.
     * Default is 30 minutes (1800 seconds).
     *
     * @default 1800
     */
    proactive_refresh_buffer_seconds: z.number().min(60).max(7200).default(1800),
    /**
     * Interval between proactive refresh checks in seconds.
     * Default is 5 minutes (300 seconds).
     *
     * @default 300
     */
    proactive_refresh_check_interval_seconds: z.number().min(30).max(1800).default(300),
    // =========================================================================
    // Rate Limiting
    // =========================================================================
    /**
     * Maximum time in seconds to wait when all accounts are rate-limited.
     * If the minimum wait time across all accounts exceeds this threshold,
     * the plugin fails fast with an error instead of hanging.
     *
     * Set to 0 to disable (wait indefinitely).
     *
     * @default 300 (5 minutes)
     */
    max_rate_limit_wait_seconds: z.number().min(0).max(3600).default(300),
    /**
     * Enable quota fallback for Gemini models.
     * When the preferred quota (gemini-cli or antigravity) is exhausted,
     * try the alternate quota on the same account before switching accounts.
     *
     * Only applies when model is requested without explicit quota suffix.
     * Explicit suffixes like `:antigravity` or `:gemini-cli` always use
     * that specific quota and switch accounts if exhausted.
     *
     * @default false
     */
    quota_fallback: z.boolean().default(false),
    /**
     * Strategy for selecting accounts when making requests.
     * Env override: OPENCODE_ANTIGRAVITY_ACCOUNT_SELECTION_STRATEGY
     * @default "sticky"
     */
    account_selection_strategy: AccountSelectionStrategySchema.default('sticky'),
    /**
     * Enable PID-based account offset for multi-session distribution.
     *
     * When enabled, different sessions (PIDs) will prefer different starting
     * accounts, which helps distribute load when running multiple parallel agents.
     *
     * When disabled (default), accounts start from the same index, which preserves
     * Anthropic's prompt cache across restarts (recommended for single-session use).
     *
     * Env override: OPENCODE_ANTIGRAVITY_PID_OFFSET_ENABLED=1
     * @default false
     */
    pid_offset_enabled: z.boolean().default(false),
    /**
     * Switch to another account immediately on first rate limit (after 1s delay).
     * When disabled, retries same account first, then switches on second rate limit.
     *
     * @default true
     */
    switch_on_first_rate_limit: z.boolean().default(true),
    // =========================================================================
    // Auto-Update
    // =========================================================================
    /**
     * Enable automatic plugin updates.
     * @default true
     */
    auto_update: z.boolean().default(true),
});
/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG = {
    quiet_mode: false,
    debug: false,
    keep_thinking: false,
    session_recovery: true,
    auto_resume: true,
    resume_text: "continue",
    empty_response_max_attempts: 4,
    empty_response_retry_delay_ms: 2000,
    tool_id_recovery: true,
    claude_tool_hardening: true,
    proactive_token_refresh: true,
    proactive_refresh_buffer_seconds: 1800,
    proactive_refresh_check_interval_seconds: 300,
    max_rate_limit_wait_seconds: 300,
    quota_fallback: false,
    account_selection_strategy: 'sticky',
    pid_offset_enabled: false,
    switch_on_first_rate_limit: true,
    auto_update: true,
    signature_cache: {
        enabled: true,
        memory_ttl_seconds: 3600,
        disk_ttl_seconds: 172800,
        write_interval_seconds: 60,
    },
};
//# sourceMappingURL=schema.js.map
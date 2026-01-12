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
export declare const AccountSelectionStrategySchema: z.ZodEnum<["sticky", "round-robin", "hybrid"]>;
export type AccountSelectionStrategy = z.infer<typeof AccountSelectionStrategySchema>;
/**
 * Signature cache configuration for persisting thinking block signatures to disk.
 */
export declare const SignatureCacheConfigSchema: z.ZodObject<{
    /** Enable disk caching of signatures (default: true) */
    enabled: z.ZodDefault<z.ZodBoolean>;
    /** In-memory TTL in seconds (default: 3600 = 1 hour) */
    memory_ttl_seconds: z.ZodDefault<z.ZodNumber>;
    /** Disk TTL in seconds (default: 172800 = 48 hours) */
    disk_ttl_seconds: z.ZodDefault<z.ZodNumber>;
    /** Background write interval in seconds (default: 60) */
    write_interval_seconds: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    enabled: boolean;
    memory_ttl_seconds: number;
    disk_ttl_seconds: number;
    write_interval_seconds: number;
}, {
    enabled?: boolean | undefined;
    memory_ttl_seconds?: number | undefined;
    disk_ttl_seconds?: number | undefined;
    write_interval_seconds?: number | undefined;
}>;
/**
 * Main configuration schema for the Antigravity OAuth plugin.
 */
export declare const AntigravityConfigSchema: z.ZodObject<{
    /** JSON Schema reference for IDE support */
    $schema: z.ZodOptional<z.ZodString>;
    /**
     * Suppress most toast notifications (rate limit, account switching, etc.)
     * Recovery toasts are always shown regardless of this setting.
     * Env override: OPENCODE_ANTIGRAVITY_QUIET=1
     * @default false
     */
    quiet_mode: z.ZodDefault<z.ZodBoolean>;
    /**
     * Enable debug logging to file.
     * Env override: OPENCODE_ANTIGRAVITY_DEBUG=1
     * @default false
     */
    debug: z.ZodDefault<z.ZodBoolean>;
    /**
     * Custom directory for debug logs.
     * Env override: OPENCODE_ANTIGRAVITY_LOG_DIR=/path/to/logs
     * @default OS-specific config dir + "/antigravity-logs"
     */
    log_dir: z.ZodOptional<z.ZodString>;
    /**
     * Preserve thinking blocks for Claude models using signature caching.
     *
     * When false (default): Thinking blocks are stripped for reliability.
     * When true: Full context preserved, but may encounter signature errors.
     *
     * Env override: OPENCODE_ANTIGRAVITY_KEEP_THINKING=1
     * @default false
     */
    keep_thinking: z.ZodDefault<z.ZodBoolean>;
    /**
     * Enable automatic session recovery from tool_result_missing errors.
     * When enabled, shows a toast notification when recoverable errors occur.
     *
     * @default true
     */
    session_recovery: z.ZodDefault<z.ZodBoolean>;
    /**
     * Automatically send a "continue" prompt after successful recovery.
     * Only applies when session_recovery is enabled.
     *
     * When false: Only shows toast notification, user must manually continue.
     * When true: Automatically sends "continue" to resume the session.
     *
     * @default true
     */
    auto_resume: z.ZodDefault<z.ZodBoolean>;
    /**
     * Custom text to send when auto-resuming after recovery.
     * Only used when auto_resume is enabled.
     *
     * @default "continue"
     */
    resume_text: z.ZodDefault<z.ZodString>;
    /**
     * Signature cache configuration for persisting thinking block signatures.
     * Only used when keep_thinking is enabled.
     */
    signature_cache: z.ZodOptional<z.ZodObject<{
        /** Enable disk caching of signatures (default: true) */
        enabled: z.ZodDefault<z.ZodBoolean>;
        /** In-memory TTL in seconds (default: 3600 = 1 hour) */
        memory_ttl_seconds: z.ZodDefault<z.ZodNumber>;
        /** Disk TTL in seconds (default: 172800 = 48 hours) */
        disk_ttl_seconds: z.ZodDefault<z.ZodNumber>;
        /** Background write interval in seconds (default: 60) */
        write_interval_seconds: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        memory_ttl_seconds: number;
        disk_ttl_seconds: number;
        write_interval_seconds: number;
    }, {
        enabled?: boolean | undefined;
        memory_ttl_seconds?: number | undefined;
        disk_ttl_seconds?: number | undefined;
        write_interval_seconds?: number | undefined;
    }>>;
    /**
     * Maximum retry attempts when Antigravity returns an empty response.
     * Empty responses occur when no candidates/choices are returned.
     *
     * @default 4
     */
    empty_response_max_attempts: z.ZodDefault<z.ZodNumber>;
    /**
     * Delay in milliseconds between empty response retries.
     *
     * @default 2000
     */
    empty_response_retry_delay_ms: z.ZodDefault<z.ZodNumber>;
    /**
     * Enable tool ID orphan recovery.
     * When tool responses have mismatched IDs (due to context compaction),
     * attempt to match them by function name or create placeholders.
     *
     * @default true
     */
    tool_id_recovery: z.ZodDefault<z.ZodBoolean>;
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
    claude_tool_hardening: z.ZodDefault<z.ZodBoolean>;
    /**
     * Enable proactive background token refresh.
     * When enabled, tokens are refreshed in the background before they expire,
     * ensuring requests never block on token refresh.
     *
     * @default true
     */
    proactive_token_refresh: z.ZodDefault<z.ZodBoolean>;
    /**
     * Seconds before token expiry to trigger proactive refresh.
     * Default is 30 minutes (1800 seconds).
     *
     * @default 1800
     */
    proactive_refresh_buffer_seconds: z.ZodDefault<z.ZodNumber>;
    /**
     * Interval between proactive refresh checks in seconds.
     * Default is 5 minutes (300 seconds).
     *
     * @default 300
     */
    proactive_refresh_check_interval_seconds: z.ZodDefault<z.ZodNumber>;
    /**
     * Maximum time in seconds to wait when all accounts are rate-limited.
     * If the minimum wait time across all accounts exceeds this threshold,
     * the plugin fails fast with an error instead of hanging.
     *
     * Set to 0 to disable (wait indefinitely).
     *
     * @default 300 (5 minutes)
     */
    max_rate_limit_wait_seconds: z.ZodDefault<z.ZodNumber>;
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
    quota_fallback: z.ZodDefault<z.ZodBoolean>;
    /**
     * Strategy for selecting accounts when making requests.
     * Env override: OPENCODE_ANTIGRAVITY_ACCOUNT_SELECTION_STRATEGY
     * @default "sticky"
     */
    account_selection_strategy: z.ZodDefault<z.ZodEnum<["sticky", "round-robin", "hybrid"]>>;
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
    pid_offset_enabled: z.ZodDefault<z.ZodBoolean>;
    /**
     * Switch to another account immediately on first rate limit (after 1s delay).
     * When disabled, retries same account first, then switches on second rate limit.
     *
     * @default true
     */
    switch_on_first_rate_limit: z.ZodDefault<z.ZodBoolean>;
    /**
     * Enable automatic plugin updates.
     * @default true
     */
    auto_update: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    debug: boolean;
    quiet_mode: boolean;
    keep_thinking: boolean;
    session_recovery: boolean;
    auto_resume: boolean;
    resume_text: string;
    empty_response_max_attempts: number;
    empty_response_retry_delay_ms: number;
    tool_id_recovery: boolean;
    claude_tool_hardening: boolean;
    proactive_token_refresh: boolean;
    proactive_refresh_buffer_seconds: number;
    proactive_refresh_check_interval_seconds: number;
    max_rate_limit_wait_seconds: number;
    quota_fallback: boolean;
    account_selection_strategy: "sticky" | "round-robin" | "hybrid";
    pid_offset_enabled: boolean;
    switch_on_first_rate_limit: boolean;
    auto_update: boolean;
    $schema?: string | undefined;
    log_dir?: string | undefined;
    signature_cache?: {
        enabled: boolean;
        memory_ttl_seconds: number;
        disk_ttl_seconds: number;
        write_interval_seconds: number;
    } | undefined;
}, {
    debug?: boolean | undefined;
    $schema?: string | undefined;
    quiet_mode?: boolean | undefined;
    log_dir?: string | undefined;
    keep_thinking?: boolean | undefined;
    session_recovery?: boolean | undefined;
    auto_resume?: boolean | undefined;
    resume_text?: string | undefined;
    signature_cache?: {
        enabled?: boolean | undefined;
        memory_ttl_seconds?: number | undefined;
        disk_ttl_seconds?: number | undefined;
        write_interval_seconds?: number | undefined;
    } | undefined;
    empty_response_max_attempts?: number | undefined;
    empty_response_retry_delay_ms?: number | undefined;
    tool_id_recovery?: boolean | undefined;
    claude_tool_hardening?: boolean | undefined;
    proactive_token_refresh?: boolean | undefined;
    proactive_refresh_buffer_seconds?: number | undefined;
    proactive_refresh_check_interval_seconds?: number | undefined;
    max_rate_limit_wait_seconds?: number | undefined;
    quota_fallback?: boolean | undefined;
    account_selection_strategy?: "sticky" | "round-robin" | "hybrid" | undefined;
    pid_offset_enabled?: boolean | undefined;
    switch_on_first_rate_limit?: boolean | undefined;
    auto_update?: boolean | undefined;
}>;
export type AntigravityConfig = z.infer<typeof AntigravityConfigSchema>;
export type SignatureCacheConfig = z.infer<typeof SignatureCacheConfigSchema>;
/**
 * Default configuration values.
 */
export declare const DEFAULT_CONFIG: AntigravityConfig;
//# sourceMappingURL=schema.d.ts.map
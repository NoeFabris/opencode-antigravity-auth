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
 * - `sticky`: Use same account until rate-limited. Preserves prompt cache.
 * - `round-robin`: Rotate to next account on every request. Maximum throughput.
 * - `hybrid` (default): Deterministic selection based on health score + token bucket + LRU freshness.
 */
export const AccountSelectionStrategySchema = z.enum(['sticky', 'round-robin', 'hybrid']);
export type AccountSelectionStrategy = z.infer<typeof AccountSelectionStrategySchema>;

/**
 * Toast notification scope for controlling which sessions show toasts.
 * 
 * - `root_only` (default): Only show toasts for root sessions (no parentID).
 *   Subagents and background tasks won't show toast notifications.
 * - `all`: Show toasts for all sessions including subagents and background tasks.
 */
export const ToastScopeSchema = z.enum(['root_only', 'all']);
export type ToastScope = z.infer<typeof ToastScopeSchema>;

/**
 * Scheduling mode for rate limit behavior.
 * 
 * - `cache_first`: Wait for same account to recover (preserves prompt cache). Default.
 * - `balance`: Switch account immediately on rate limit. Maximum availability.
 * - `performance_first`: Round-robin distribution for maximum throughput.
 */
export const SchedulingModeSchema = z.enum(['cache_first', 'balance', 'performance_first']);
export type SchedulingMode = z.infer<typeof SchedulingModeSchema>;

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
   * Control which sessions show toast notifications.
   * 
   * - `root_only` (default): Only root sessions show toasts.
   *   Subagents and background tasks will be silent (less spam).
   * - `all`: All sessions show toasts including subagents and background tasks.
   * 
   * Debug logging captures all toasts regardless of this setting.
   * Env override: OPENCODE_ANTIGRAVITY_TOAST_SCOPE=all
   * @default "root_only"
   */
  toast_scope: ToastScopeSchema.default('root_only'),

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
   * @default false
   */
  auto_resume: z.boolean().default(false),

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
   * Prefer gemini-cli routing before Antigravity for Gemini models.
   * 
   * When false (default): Antigravity is tried first, then gemini-cli.
   * When true: gemini-cli is tried first, then Antigravity.
   * 
   * @default false
   */
  cli_first: z.boolean().default(false),

  /**
   * Strategy for selecting accounts when making requests.
   * Env override: OPENCODE_ANTIGRAVITY_ACCOUNT_SELECTION_STRATEGY
   * @default "hybrid"
   */
  account_selection_strategy: AccountSelectionStrategySchema.default('hybrid'),

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

  /**
   * Scheduling mode for rate limit behavior.
   * 
   * - `cache_first`: Wait for same account to recover (preserves prompt cache). Default.
   * - `balance`: Switch account immediately on rate limit. Maximum availability.
   * - `performance_first`: Round-robin distribution for maximum throughput.
   * 
   * Env override: OPENCODE_ANTIGRAVITY_SCHEDULING_MODE
   * @default "cache_first"
   */
  scheduling_mode: SchedulingModeSchema.default('cache_first'),

  /**
   * Maximum seconds to wait for same account in cache_first mode.
   * If the account's rate limit reset time exceeds this, switch accounts.
   * 
   * @default 60
   */
  max_cache_first_wait_seconds: z.number().min(5).max(300).default(60),

  /**
   * TTL in seconds for failure count expiration.
   * After this period of no failures, consecutiveFailures resets to 0.
   * This prevents old failures from permanently penalizing an account.
   * 
   * @default 3600 (1 hour)
   */
  failure_ttl_seconds: z.number().min(60).max(7200).default(3600),

  /**
   * Default retry delay in seconds when API doesn't return a retry-after header.
   * Lower values allow faster retries but may trigger more 429 errors.
   * 
   * @default 60
   */
  default_retry_after_seconds: z.number().min(1).max(300).default(60),

  /**
   * Maximum backoff delay in seconds for exponential retry.
   * This caps how long the exponential backoff can grow.
   * 
   * @default 60
   */
  max_backoff_seconds: z.number().min(5).max(300).default(60),

  /**
   * Maximum random delay in milliseconds before each API request.
   * Adds timing jitter to break predictable request cadence patterns.
   * Set to 0 to disable request jitter.
   * 
   * @default 0
   */
  request_jitter_max_ms: z.number().min(0).max(5000).default(0),

  /**
   * Soft quota threshold percentage (1-100).
   * When an account's quota usage reaches this percentage, skip it during
   * account selection (same as if it were rate-limited).
   * 
   * Example: 90 means skip account when 90% of quota is used (10% remaining).
   * Set to 100 to disable soft quota protection.
   * 
   * @default 90
   */
  soft_quota_threshold_percent: z.number().min(1).max(100).default(90),

  /**
   * How often to refresh quota data in the background (in minutes).
   * Quota is refreshed opportunistically after successful API requests.
   * Set to 0 to disable automatic refresh (manual only via Check quotas).
   * 
   * @default 15
   */
  quota_refresh_interval_minutes: z.number().min(0).max(60).default(15),

  /**
   * How long quota cache is considered fresh for threshold checks (in minutes).
   * After this time, cache is stale and account is allowed (fail-open).
   * 
   * "auto" = derive from refresh interval: max(2 * refresh_interval, 10)
   * 
   * @default "auto"
   */
  soft_quota_cache_ttl_minutes: z.union([
    z.literal("auto"),
    z.number().min(1).max(120)
  ]).default("auto"),

  // =========================================================================
  // Health Score (used by hybrid strategy)
  // =========================================================================

  health_score: z.object({
    initial: z.number().min(0).max(100).default(70),
    success_reward: z.number().min(0).max(10).default(1),
    rate_limit_penalty: z.number().min(-50).max(0).default(-10),
    failure_penalty: z.number().min(-100).max(0).default(-20),
    recovery_rate_per_hour: z.number().min(0).max(20).default(2),
    min_usable: z.number().min(0).max(100).default(50),
    max_score: z.number().min(50).max(100).default(100),
  }).optional(),

  // =========================================================================
  // Token Bucket (for hybrid strategy)
  // =========================================================================

  token_bucket: z.object({
    max_tokens: z.number().min(1).max(1000).default(50),
    regeneration_rate_per_minute: z.number().min(0.1).max(60).default(6),
    initial_tokens: z.number().min(1).max(1000).default(50),
  }).optional(),

  // =========================================================================
  // Auto-Update
  // =========================================================================

  /**
   * Enable automatic plugin updates.
   * @default true
   */
  auto_update: z.boolean().default(true),

  // =========================================================================
  // Error Notifications
  // =========================================================================

  /**
   * Enable notifications when an account encounters an error.
   * Shows toast notification and optionally sends Telegram message.
   * 
   * @default true
   */
  notify_on_account_error: z.boolean().default(true),

  /**
   * Telegram bot token for remote error notifications.
   * Create a bot via @BotFather on Telegram to get this.
   * 
   * Env override: OPENCODE_ANTIGRAVITY_TELEGRAM_BOT_TOKEN
   */
  telegram_bot_token: z.string().optional(),

  /**
   * Your Telegram chat ID for receiving notifications.
   * Use @userinfobot on Telegram to find your chat ID.
   * 
   * Env override: OPENCODE_ANTIGRAVITY_TELEGRAM_CHAT_ID
   */
  telegram_chat_id: z.string().optional(),

  /**
   * Cooldown in seconds between notifications of the same error type.
   * Prevents notification spam when multiple errors occur quickly.
   * Set to 0 to disable cooldown (receive all notifications).
   * 
   * @default 60 (1 minute)
   */
  notification_cooldown_seconds: z.number().min(0).max(300).default(60),

});

export type AntigravityConfig = z.infer<typeof AntigravityConfigSchema>;
export type SignatureCacheConfig = z.infer<typeof SignatureCacheConfigSchema>;

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: AntigravityConfig = {
  quiet_mode: false,
  toast_scope: 'root_only',
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
  cli_first: false,
  account_selection_strategy: 'hybrid',
  pid_offset_enabled: false,
  switch_on_first_rate_limit: true,
  scheduling_mode: 'cache_first',
  max_cache_first_wait_seconds: 60,
  failure_ttl_seconds: 3600,
  default_retry_after_seconds: 60,
  max_backoff_seconds: 60,
  request_jitter_max_ms: 0,
  soft_quota_threshold_percent: 90,
  quota_refresh_interval_minutes: 15,
  soft_quota_cache_ttl_minutes: "auto",
  auto_update: true,
  notify_on_account_error: true,
  notification_cooldown_seconds: 60,
  signature_cache: {
    enabled: true,
    memory_ttl_seconds: 3600,
    disk_ttl_seconds: 172800,
    write_interval_seconds: 60,
  },
  health_score: {
    initial: 70,
    success_reward: 1,
    rate_limit_penalty: -10,
    failure_penalty: -20,
    recovery_rate_per_hour: 2,
    min_usable: 50,
    max_score: 100,
  },
  token_bucket: {
    max_tokens: 50,
    regeneration_rate_per_minute: 6,
    initial_tokens: 50,
  },
};

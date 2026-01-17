import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AntigravityConfigSchema } from "../src/plugin/config/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, "../assets/antigravity.schema.json");

const jsonSchema = zodToJsonSchema(AntigravityConfigSchema as any, {
  name: "AntigravityConfig",
  $refStrategy: "none",
}) as Record<string, unknown>;

const envVarDescriptions: Record<string, string> = {
  quiet_mode:
    "Suppress most toast notifications (rate limit, account switching). Recovery toasts always shown. Env: OPENCODE_ANTIGRAVITY_QUIET=1",
  debug:
    "Enable debug logging to file. Env: OPENCODE_ANTIGRAVITY_DEBUG=1 (or =2 for verbose)",
  log_dir:
    "Custom directory for debug logs. Env: OPENCODE_ANTIGRAVITY_LOG_DIR=/path/to/logs",
  keep_thinking:
    "Preserve thinking blocks for Claude models using signature caching. May cause signature errors. Env: OPENCODE_ANTIGRAVITY_KEEP_THINKING=1",
  session_recovery:
    "Enable automatic session recovery from tool_result_missing errors. Env: OPENCODE_ANTIGRAVITY_SESSION_RECOVERY=1",
  auto_resume:
    "Automatically send resume prompt after successful recovery. Env: OPENCODE_ANTIGRAVITY_AUTO_RESUME=1",
  resume_text:
    "Custom text to send when auto-resuming after recovery. Env: OPENCODE_ANTIGRAVITY_RESUME_TEXT=continue",
  empty_response_max_attempts:
    "Maximum retry attempts when Antigravity returns an empty response (no candidates).",
  empty_response_retry_delay_ms:
    "Delay in milliseconds between empty response retries.",
  tool_id_recovery:
    "Enable tool ID orphan recovery. Matches mismatched tool responses by function name or creates placeholders.",
  claude_tool_hardening:
    "Enable tool hallucination prevention for Claude models. Injects parameter signatures and strict usage rules.",
  proactive_token_refresh:
    "Enable proactive background token refresh before expiry, ensuring requests never block.",
  proactive_refresh_buffer_seconds:
    "Seconds before token expiry to trigger proactive refresh.",
  proactive_refresh_check_interval_seconds:
    "Interval between proactive refresh checks in seconds.",
  auto_update: "Enable automatic plugin updates. Env: OPENCODE_ANTIGRAVITY_AUTO_UPDATE=1",
};

const signatureCacheDescriptions: Record<string, string> = {
  enabled: "Enable disk caching of thinking block signatures.",
  memory_ttl_seconds: "In-memory TTL in seconds.",
  disk_ttl_seconds: "Disk TTL in seconds.",
  write_interval_seconds: "Background write interval in seconds.",
};

function addDescriptions(schema: Record<string, unknown>): void {
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return;

  for (const [key, prop] of Object.entries(props)) {
    if (envVarDescriptions[key]) {
      prop.description = envVarDescriptions[key];
    }

    if (key === "signature_cache" && prop.properties) {
      const cacheProps = prop.properties as Record<string, Record<string, unknown>>;
      for (const [cacheKey, cacheProp] of Object.entries(cacheProps)) {
        if (signatureCacheDescriptions[cacheKey]) {
          cacheProp.description = signatureCacheDescriptions[cacheKey];
        }
      }
      prop.description = "Signature cache configuration for persisting thinking block signatures. Only used when keep_thinking is enabled.";
    }
  }
}

const definitions = jsonSchema.definitions as Record<string, Record<string, unknown>> | undefined;
if (definitions?.AntigravityConfig) {
  addDescriptions(definitions.AntigravityConfig);
} else {
  addDescriptions(jsonSchema);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2) + "\n");

console.log(`Schema written to ${outputPath}`);

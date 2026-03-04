#!/usr/bin/env npx tsx
import { spawn } from "child_process";

interface ModelTest {
  model: string;
  category: "gemini-cli" | "antigravity-gemini" | "antigravity-claude";
  optional?: boolean;
}

const MODELS: ModelTest[] = [
  // Gemini CLI (direct Google API)
  { model: "google/gemini-3-flash-preview", category: "gemini-cli" },
  { model: "google/gemini-3.1-pro-preview", category: "gemini-cli" },
  { model: "google/gemini-2.5-pro", category: "gemini-cli", optional: true },
  { model: "google/gemini-2.5-flash", category: "gemini-cli" },

  // Antigravity Gemini
  { model: "google/antigravity-gemini-3-pro-low", category: "antigravity-gemini" },
  { model: "google/antigravity-gemini-3-pro-high", category: "antigravity-gemini" },
  { model: "google/antigravity-gemini-3-flash", category: "antigravity-gemini" },

  // Antigravity Claude
  { model: "google/antigravity-claude-sonnet-4-6", category: "antigravity-claude" },
  { model: "google/antigravity-claude-opus-4-6-thinking-low", category: "antigravity-claude" },
  { model: "google/antigravity-claude-opus-4-6-thinking-medium", category: "antigravity-claude" },
  { model: "google/antigravity-claude-opus-4-6-thinking-high", category: "antigravity-claude" },
];

const TEST_PROMPT = "Reply with exactly one word: WORKING";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ERROR_SNIPPET_CHARS = 400;

interface TestResult {
  success: boolean;
  error?: string;
  duration: number;
}

function parseTimeoutMs(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag} value "${value}". Expected a positive integer.`);
  }
  return parsed;
}

function collectRepeatedArgValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === flag) {
      const next = args[index + 1];
      if (next === undefined) {
        throw new Error(`Missing value for ${flag}`);
      }
      values.push(next);
    }
  }
  return values;
}

function parseModelTimeoutOverrides(specs: string[]): Map<string, number> {
  const overrides = new Map<string, number>();
  for (const spec of specs) {
    const separator = spec.lastIndexOf("=");
    if (separator <= 0 || separator === spec.length - 1) {
      throw new Error(`Invalid --timeout-model value "${spec}". Expected "<model>=<ms>".`);
    }
    const model = spec.slice(0, separator).trim();
    const timeoutRaw = spec.slice(separator + 1).trim();
    const timeoutMs = parseTimeoutMs(timeoutRaw, "--timeout-model");
    overrides.set(model, timeoutMs);
  }
  return overrides;
}

function summarizeDiagnostic(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "<empty>";
  }
  if (normalized.length <= MAX_ERROR_SNIPPET_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_ERROR_SNIPPET_CHARS)}...`;
}

function resolveTimeoutForModel(model: string, defaultTimeout: number, modelTimeoutOverrides: Map<string, number>): number {
  const exact = modelTimeoutOverrides.get(model);
  if (exact !== undefined) {
    return exact;
  }

  for (const [pattern, timeout] of modelTimeoutOverrides) {
    if (model.endsWith(pattern)) {
      return timeout;
    }
  }
  return defaultTimeout;
}

async function testModel(model: string, timeoutMs: number): Promise<TestResult> {
  const start = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const proc = spawn("opencode", ["run", TEST_PROMPT, "--model", model], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      const diagnostic = summarizeDiagnostic(stderr || stdout);
      if (!settled) {
        settled = true;
        resolve({ success: false, error: `Timeout after ${timeoutMs}ms: ${diagnostic}`, duration: Date.now() - start });
      }
    }, timeoutMs);

    proc.stdout?.on("data", (data) => { stdout += data.toString(); });
    proc.stderr?.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const duration = Date.now() - start;
      if (settled) {
        return;
      }
      settled = true;

      if (code !== 0) {
        const diagnostic = summarizeDiagnostic(stderr || stdout);
        resolve({ success: false, error: `Exit ${code}: ${diagnostic}`, duration });
      } else {
        resolve({ success: true, duration });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      resolve({ success: false, error: err.message, duration: Date.now() - start });
    });
  });
}

function parseArgs(): {
  filterModel: string | null;
  filterCategory: string | null;
  dryRun: boolean;
  help: boolean;
  timeout: number;
  modelTimeoutOverrides: Map<string, number>;
} {
  const args = process.argv.slice(2);
  const modelIdx = args.indexOf("--model");
  const catIdx = args.indexOf("--category");
  const timeoutIdx = args.indexOf("--timeout");
  const modelTimeoutOverrideSpecs = collectRepeatedArgValues(args, "--timeout-model");

  return {
    filterModel: modelIdx !== -1 ? args[modelIdx + 1] ?? null : null,
    filterCategory: catIdx !== -1 ? args[catIdx + 1] ?? null : null,
    dryRun: args.includes("--dry-run"),
    help: args.includes("--help") || args.includes("-h"),
    timeout: timeoutIdx !== -1 ? parseTimeoutMs(args[timeoutIdx + 1] || "120000", "--timeout") : DEFAULT_TIMEOUT_MS,
    modelTimeoutOverrides: parseModelTimeoutOverrides(modelTimeoutOverrideSpecs),
  };
}

function printHelp(): void {
  console.log(`
E2E Model Test Script

Usage:
  npx tsx script/test-models.ts [options]

Options:
  --model <model>      Test specific model
  --category <cat>     Test by category (gemini-cli, antigravity-gemini, antigravity-claude)
  --timeout <ms>       Timeout per model (default: 120000)
  --timeout-model <spec>
                       Per-model timeout override. Repeatable. Format: "<model>=<ms>"
  --dry-run            List models without testing
  --help, -h           Show this help

Examples:
  npx tsx script/test-models.ts --dry-run
  npx tsx script/test-models.ts --model google/gemini-3-flash-preview
  npx tsx script/test-models.ts --category antigravity-claude
  npx tsx script/test-models.ts --timeout-model google/gemini-3.1-pro-preview=240000
`);
}

async function main(): Promise<void> {
  const { filterModel, filterCategory, dryRun, help, timeout, modelTimeoutOverrides } = parseArgs();

  if (help) {
    printHelp();
    return;
  }

  let tests = MODELS;
  if (filterModel) tests = tests.filter((t) => t.model === filterModel || t.model.endsWith(filterModel));
  if (filterCategory) tests = tests.filter((t) => t.category === filterCategory);

  if (tests.length === 0) {
    console.log("No models match the filter.");
    return;
  }

  console.log(`\n🧪 E2E Model Tests (${tests.length} models)\n${"=".repeat(50)}\n`);

  if (dryRun) {
    for (const t of tests) {
      const optionalSuffix = t.optional ? " (optional)" : "";
      console.log(`  ${t.model.padEnd(50)} [${t.category}]${optionalSuffix}`);
    }
    console.log(`\n${tests.length} models would be tested.\n`);
    return;
  }

  let passed = 0;
  let failed = 0;
  let optionalFailed = 0;
  const requiredFailures: { model: string; error: string }[] = [];
  const optionalFailures: { model: string; error: string }[] = [];

  for (const t of tests) {
    const timeoutForModel = resolveTimeoutForModel(t.model, timeout, modelTimeoutOverrides);
    process.stdout.write(`Testing ${t.model.padEnd(50)} ... `);
    const result = await testModel(t.model, timeoutForModel);

    if (result.success) {
      console.log(`✅ (${(result.duration / 1000).toFixed(1)}s)`);
      passed++;
    } else {
      if (t.optional) {
        console.log(`⚠️ OPTIONAL FAIL`);
      } else {
        console.log(`❌ FAIL`);
      }
      console.log(`   ${result.error}`);
      console.log(`   timeout=${timeoutForModel}ms`);
      const failure = { model: t.model, error: result.error || "Unknown" };
      if (t.optional) {
        optionalFailures.push(failure);
        optionalFailed++;
      } else {
        requiredFailures.push(failure);
        failed++;
      }
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Summary: ${passed} passed, ${failed} failed, ${optionalFailed} optional failed\n`);

  if (requiredFailures.length > 0) {
    console.log("Failed required models:");
    for (const f of requiredFailures) {
      console.log(`  - ${f.model}`);
    }
    process.exit(1);
  }

  if (optionalFailures.length > 0) {
    console.log("Failed optional models:");
    for (const f of optionalFailures) {
      console.log(`  - ${f.model}`);
    }
  }
}

main().catch(console.error);

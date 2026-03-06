#!/usr/bin/env npx tsx
import { spawn } from "child_process";

type Category = "thinking-order" | "tool-pairing" | "multi-tool" | "multi-provider" | "error-handling" | "stress" | "concurrency";
type TestSuite = "sanity" | "heavy" | "all";

interface MultiTurnTest {
  name: string;
  model: string;
  category: Category;
  suite: TestSuite;
  turns: (string | TurnConfig)[];
  errorPatterns: string[];
  timeout: number;
  expectError?: string;
}

interface TurnConfig {
  prompt: string;
  model?: string;
  timeout?: number;
}

interface RunTurnResult {
  output: string;
  stderr: string;
  code: number;
  sessionId: string | null;
  timedOut: boolean;
  duration: number;
}

interface TestResult {
  success: boolean;
  error?: string;
  duration: number;
  turnsCompleted: number;
  sessionId?: string;
}

interface ConcurrentTest {
  name: string;
  category: "concurrency";
  suite: TestSuite;
  concurrentRequests: number;
  model: string;
  prompt: string;
  errorPatterns: string[];
  timeout: number;
}

interface TimeoutOverrides {
  defaultTimeout: number | null;
  testTimeoutOverrides: Map<string, number>;
  turnTimeoutOverrides: Map<string, number>;
}

const ERROR_PATTERNS = [
  "thinking block order",
  "Expected thinking or redacted_thinking",
  "tool_use ids were found without tool_result",
  "tool_result_missing",
  "thinking_disabled_violation",
  "orphaned tool_use",
  "must start with thinking block",
  "error: tool_use without matching tool_result",
  "cannot be modified",
  "must remain as they were",
];

const GEMINI_FLASH = "google/antigravity-gemini-3-flash";
const GEMINI_FLASH_CLI_QUOTA = "google/gemini-2.5-flash";
const CLAUDE_SONNET = "google/antigravity-claude-sonnet-4-6";
const CLAUDE_OPUS = "google/antigravity-claude-opus-4-6-thinking-low";

const SANITY_TESTS: MultiTurnTest[] = [
  {
    name: "thinking-tool-use",
    model: CLAUDE_SONNET,
    category: "thinking-order",
    suite: "sanity",
    turns: ["Read package.json and tell me the package name"],
    errorPatterns: ERROR_PATTERNS,
    timeout: 90000,
  },
  {
    name: "thinking-bash-tool",
    model: CLAUDE_SONNET,
    category: "thinking-order",
    suite: "sanity",
    turns: ["Run: echo 'hello' and tell me the output"],
    errorPatterns: ERROR_PATTERNS,
    timeout: 90000,
  },
  {
    name: "tool-pairing-sequential",
    model: CLAUDE_SONNET,
    category: "tool-pairing",
    suite: "sanity",
    turns: ["Run: echo 'first'", "Run: echo 'second'"],
    errorPatterns: ERROR_PATTERNS,
    timeout: 120000,
  },
  {
    name: "opus-thinking-basic",
    model: CLAUDE_OPUS,
    category: "thinking-order",
    suite: "sanity",
    turns: ["What is 7 * 8? Use bash to verify: echo $((7*8))"],
    errorPatterns: ERROR_PATTERNS,
    timeout: 120000,
  },
  {
    name: "thinking-modification-continue",
    model: CLAUDE_SONNET,
    category: "thinking-order",
    suite: "sanity",
    turns: [
      "Read package.json and tell me the version",
      "Now read tsconfig.json and tell me the target",
      "Compare the two files briefly",
    ],
    errorPatterns: ERROR_PATTERNS,
    timeout: 120000,
  },
  {
    name: "multi-provider-switch",
    model: GEMINI_FLASH,
    category: "multi-provider",
    suite: "sanity",
    turns: [
      { prompt: "What is 2+2? Answer briefly.", model: GEMINI_FLASH },
      { prompt: "What is 3+3? Answer briefly.", model: CLAUDE_SONNET },
      { prompt: "What is 4+4? Answer briefly.", model: GEMINI_FLASH },
    ],
    errorPatterns: ERROR_PATTERNS,
    timeout: 180000,
  },
  {
    name: "prompt-too-long-recovery",
    model: GEMINI_FLASH,
    category: "error-handling",
    suite: "sanity",
    turns: ["Reply with exactly: OK", "Repeat the word 'test' 50000 times"],
    errorPatterns: ["FATAL", "unhandled", "Cannot read properties"],
    timeout: 180000,
  },
];

const HEAVY_TESTS: MultiTurnTest[] = [
  {
    name: "stress-8-turn-multi-provider",
    model: GEMINI_FLASH,
    category: "stress",
    suite: "heavy",
    turns: [
      { prompt: "Read package.json and tell me the name", model: GEMINI_FLASH },
      { prompt: "Now read tsconfig.json and tell me the target", model: CLAUDE_SONNET },
      { prompt: "Run: ls -la src/plugin | head -5", model: GEMINI_FLASH },
      { prompt: "Read src/plugin/auth.ts and summarize in 1 sentence", model: CLAUDE_SONNET },
      { prompt: "Run: wc -l src/plugin/*.ts | tail -3", model: GEMINI_FLASH },
      { prompt: "Read README.md first 50 lines and tell me what this project does", model: CLAUDE_SONNET },
      { prompt: "Run: git log --oneline -3", model: GEMINI_FLASH },
      { prompt: "Summarize everything we discussed in 3 bullet points", model: CLAUDE_SONNET },
    ],
    errorPatterns: ERROR_PATTERNS,
    timeout: 600000,
  },
  {
    name: "opencode-tools-comprehensive",
    model: CLAUDE_SONNET,
    category: "multi-tool",
    suite: "heavy",
    turns: [
      "Use glob to find all *.ts files in src/plugin directory",
      "Use grep to search for 'async function' in src/plugin/auth.ts",
      "Use bash to run: echo 'test123' && pwd",
      "Use read to read the first 20 lines of package.json",
      "Use lsp_diagnostics on src/plugin/auth.ts to check for errors",
      "Use glob to find all test files matching *.test.ts",
    ],
    errorPatterns: ERROR_PATTERNS,
    timeout: 480000,
  },
  {
    name: "stress-20-turn-recovery",
    model: GEMINI_FLASH,
    category: "stress",
    suite: "heavy",
    turns: [
      { prompt: "Read package.json and extract the version number only", model: GEMINI_FLASH },
      { prompt: "Run: ls src/plugin/*.ts | head -3", model: CLAUDE_SONNET },
      { prompt: "Read src/plugin/auth.ts first 30 lines", model: GEMINI_FLASH },
      { prompt: "Use grep to find 'export' in src/plugin/auth.ts", model: CLAUDE_SONNET },
      { prompt: "Run: echo 'checkpoint 1' && date", model: GEMINI_FLASH },
      { prompt: "Read tsconfig.json and tell me the module type", model: CLAUDE_SONNET },
      { prompt: "Use glob to find all *.test.ts files", model: GEMINI_FLASH },
      { prompt: "Read src/plugin/token.ts first 20 lines", model: CLAUDE_SONNET },
      { prompt: "Run: wc -l src/plugin/*.ts | sort -n | tail -5", model: GEMINI_FLASH },
      { prompt: "What files have we read so far? List them.", model: CLAUDE_SONNET },
      { prompt: "Read src/plugin/request.ts first 25 lines", model: GEMINI_FLASH },
      { prompt: "Use grep to find 'async' in src/plugin/request.ts", model: CLAUDE_SONNET },
      { prompt: "Run: echo 'checkpoint 2' && pwd", model: GEMINI_FLASH },
      { prompt: "Read src/plugin/storage.ts first 20 lines", model: CLAUDE_SONNET },
      { prompt: "Use lsp_diagnostics on src/plugin/token.ts", model: GEMINI_FLASH },
      { prompt: "Read vitest.config.ts completely", model: CLAUDE_SONNET },
      { prompt: "Run: git status --short | head -5", model: GEMINI_FLASH },
      { prompt: "Read src/constants.ts completely", model: CLAUDE_SONNET },
      { prompt: "Run: echo 'final checkpoint' && echo 'all done'", model: GEMINI_FLASH },
      { prompt: "Summarize this entire conversation in 5 bullet points", model: CLAUDE_SONNET },
    ],
    errorPatterns: ERROR_PATTERNS,
    timeout: 900000,
  },
  {
    name: "stress-50-turn-endurance",
    model: GEMINI_FLASH,
    category: "stress",
    suite: "heavy",
    turns: generateEnduranceTest(50),
    errorPatterns: ERROR_PATTERNS,
    timeout: 1800000,
  },
];

function generateEnduranceTest(turnCount: number): TurnConfig[] {
  const turns: TurnConfig[] = [];
  const prompts = [
    { prompt: "What is {n} + {n}? Answer with just the number.", model: GEMINI_FLASH },
    { prompt: "Run: echo 'turn {i}'", model: CLAUDE_SONNET },
    { prompt: "Read package.json and tell me one field", model: GEMINI_FLASH },
    { prompt: "Run: pwd && echo 'ok'", model: CLAUDE_SONNET },
    { prompt: "What turn number are we on? Just say the number.", model: GEMINI_FLASH },
    { prompt: "Run: date +%H:%M:%S", model: CLAUDE_SONNET },
    { prompt: "Use glob to find one .ts file in src/", model: GEMINI_FLASH },
    { prompt: "Run: echo 'checkpoint {i}'", model: CLAUDE_SONNET },
    { prompt: "Read tsconfig.json and tell me target", model: GEMINI_FLASH },
    { prompt: "What have we done in last 3 turns? Brief answer.", model: CLAUDE_SONNET },
  ];

  for (let i = 0; i < turnCount; i++) {
    const template = prompts[i % prompts.length]!;
    const prompt = template.prompt
      .replace(/\{i\}/g, String(i + 1))
      .replace(/\{n\}/g, String(i + 1));
    turns.push({ prompt, model: template.model });
  }

  turns.push({
    prompt: `We completed ${turnCount} turns. Summarize this session in 3 sentences.`,
    model: CLAUDE_SONNET,
  });

  return turns;
}

const RATE_LIMIT_ERROR_PATTERNS = [
  "false alarm",
  "incorrectly marked as rate limited",
  "wrong quota",
];

const CONCURRENT_TESTS: ConcurrentTest[] = [
  {
    name: "concurrent-5-same-model",
    category: "concurrency",
    suite: "heavy",
    concurrentRequests: 5,
    model: GEMINI_FLASH,
    prompt: "What is 2+2? Answer with just the number.",
    errorPatterns: [...ERROR_PATTERNS, ...RATE_LIMIT_ERROR_PATTERNS],
    timeout: 120000,
  },
  {
    name: "concurrent-3-mixed-models",
    category: "concurrency",
    suite: "heavy",
    concurrentRequests: 3,
    model: GEMINI_FLASH,
    prompt: "Say hello in one word.",
    errorPatterns: [...ERROR_PATTERNS, ...RATE_LIMIT_ERROR_PATTERNS],
    timeout: 120000,
  },
  {
    name: "concurrent-10-antigravity-heavy",
    category: "concurrency",
    suite: "heavy",
    concurrentRequests: 10,
    model: GEMINI_FLASH,
    prompt: "What is 1+1? Answer with just the number.",
    errorPatterns: [...ERROR_PATTERNS, ...RATE_LIMIT_ERROR_PATTERNS],
    timeout: 180000,
  },
];

const ALL_TESTS = [...SANITY_TESTS, ...HEAVY_TESTS];
const MAX_DIAGNOSTIC_CHARS = 500;

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
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${flag}`);
      }
      values.push(value);
    }
  }
  return values;
}

function parseNamedTimeoutOverrides(specs: string[], flag: string): Map<string, number> {
  const overrides = new Map<string, number>();
  for (const spec of specs) {
    const separator = spec.lastIndexOf("=");
    if (separator <= 0 || separator === spec.length - 1) {
      throw new Error(`Invalid ${flag} value "${spec}". Expected "<name>=<ms>".`);
    }
    const name = spec.slice(0, separator).trim();
    const timeoutRaw = spec.slice(separator + 1).trim();
    const timeoutMs = parseTimeoutMs(timeoutRaw, flag);
    overrides.set(name, timeoutMs);
  }
  return overrides;
}

function parseTurnTimeoutOverrides(specs: string[]): Map<string, number> {
  const overrides = new Map<string, number>();
  for (const spec of specs) {
    const separator = spec.lastIndexOf("=");
    if (separator <= 0 || separator === spec.length - 1) {
      throw new Error(`Invalid --timeout-turn value "${spec}". Expected "<test>:<turn>=<ms>".`);
    }
    const key = spec.slice(0, separator).trim();
    const timeoutRaw = spec.slice(separator + 1).trim();
    const keyParts = key.split(":");
    if (keyParts.length !== 2) {
      throw new Error(`Invalid --timeout-turn value "${spec}". Expected "<test>:<turn>=<ms>".`);
    }
    const testName = keyParts[0]?.trim();
    const turnIndexRaw = keyParts[1]?.trim();
    if (!testName || !turnIndexRaw) {
      throw new Error(`Invalid --timeout-turn value "${spec}". Expected "<test>:<turn>=<ms>".`);
    }
    const turnIndex = Number.parseInt(turnIndexRaw, 10);
    if (!Number.isFinite(turnIndex) || turnIndex <= 0) {
      throw new Error(`Invalid turn index in --timeout-turn value "${spec}". Expected a positive integer.`);
    }
    const timeoutMs = parseTimeoutMs(timeoutRaw, "--timeout-turn");
    overrides.set(`${testName}:${turnIndex}`, timeoutMs);
  }
  return overrides;
}

function summarizeDiagnostic(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "<empty>";
  }
  if (normalized.length <= MAX_DIAGNOSTIC_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_DIAGNOSTIC_CHARS)}...`;
}

function resolveBaseTimeout(name: string, defaultTimeout: number, timeoutOverrides: TimeoutOverrides): number {
  let timeout = defaultTimeout;
  if (timeoutOverrides.defaultTimeout !== null) {
    timeout = timeoutOverrides.defaultTimeout;
  }
  const testOverride = timeoutOverrides.testTimeoutOverrides.get(name);
  if (testOverride !== undefined) {
    timeout = testOverride;
  }
  return timeout;
}

function resolveTurnTimeout(
  test: MultiTurnTest,
  turn: string | TurnConfig,
  turnIndex: number,
  timeoutOverrides: TimeoutOverrides
): number {
  let timeout = resolveBaseTimeout(test.name, test.timeout, timeoutOverrides);
  if (typeof turn !== "string" && turn.timeout !== undefined) {
    timeout = turn.timeout;
  }
  const turnOverride = timeoutOverrides.turnTimeoutOverrides.get(`${test.name}:${turnIndex + 1}`);
  if (turnOverride !== undefined) {
    timeout = turnOverride;
  }
  return timeout;
}

function applyTimeoutOverridesToTests(tests: MultiTurnTest[], timeoutOverrides: TimeoutOverrides): MultiTurnTest[] {
  return tests.map((test) => ({
    ...test,
    timeout: resolveBaseTimeout(test.name, test.timeout, timeoutOverrides),
  }));
}

function applyTimeoutOverridesToConcurrentTests(tests: ConcurrentTest[], timeoutOverrides: TimeoutOverrides): ConcurrentTest[] {
  return tests.map((test) => ({
    ...test,
    timeout: resolveBaseTimeout(test.name, test.timeout, timeoutOverrides),
  }));
}

async function runTurn(
  prompt: string,
  model: string,
  sessionId: string | null,
  sessionTitle: string,
  timeout: number
): Promise<RunTurnResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = sessionId
      ? ["run", prompt, "--session", sessionId, "--model", model]
      : ["run", prompt, "--model", model, "--title", sessionTitle];

    const proc = spawn("opencode", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        proc.kill("SIGKILL");
      }, 2000).unref();
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timeoutId);

      let extractedSessionId = sessionId;
      if (!extractedSessionId) {
        const match = stdout.match(/session[:\s]+([a-zA-Z0-9_-]+)/i) ||
                      stderr.match(/session[:\s]+([a-zA-Z0-9_-]+)/i);
        if (match) {
          extractedSessionId = match[1] ?? null;
        }
      }

      resolve({
        output: stdout,
        stderr: stderr,
        code: code ?? 1,
        sessionId: extractedSessionId,
        timedOut,
        duration: Date.now() - start,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      resolve({
        output: "",
        stderr: err.message,
        code: 1,
        sessionId: null,
        timedOut: false,
        duration: Date.now() - start,
      });
    });
  });
}

async function deleteSession(sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn("opencode", ["session", "delete", sessionId, "--force"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
      cwd: process.cwd(),
    });

    proc.on("close", () => resolve());
    proc.on("error", () => resolve());
  });
}

async function runConcurrentTest(test: ConcurrentTest): Promise<TestResult> {
  const start = Date.now();
  const sessionIds: string[] = [];

  process.stdout.write(`  Spawning ${test.concurrentRequests} concurrent requests...`);

  const promises = Array.from({ length: test.concurrentRequests }, (_, i) =>
    runTurn(
      `${test.prompt} (request ${i + 1})`,
      test.model,
      null,
      `concurrent-${test.name}-${i}`,
      test.timeout
    )
  );

  const results = await Promise.all(promises);
  process.stdout.write("\r" + " ".repeat(60) + "\r");

  for (const result of results) {
    if (result.sessionId) {
      sessionIds.push(result.sessionId);
    }
  }

  for (const result of results) {
    const combinedOutput = `${result.stderr}\n${result.output}`.toLowerCase();
    for (const pattern of test.errorPatterns) {
      if (combinedOutput.includes(pattern.toLowerCase())) {
        for (const sid of sessionIds) {
          await deleteSession(sid);
        }
        return {
          success: false,
          error: `Found error pattern "${pattern}" in concurrent response`,
          duration: Date.now() - start,
          turnsCompleted: 0,
        };
      }
    }
  }

  const failedResults = results.filter((r) => r.code !== 0 || r.timedOut);
  const failedCount = failedResults.length;
  if (failedCount > test.concurrentRequests / 2) {
    for (const sid of sessionIds) {
      await deleteSession(sid);
    }
    const firstFailure = failedResults[0];
    const timedOutCount = failedResults.filter((result) => result.timedOut).length;
    const failureDetails = firstFailure
      ? `\n    First failure: ${summarizeDiagnostic(firstFailure.stderr || firstFailure.output)}`
      : "";
    return {
      success: false,
      error: `${failedCount}/${test.concurrentRequests} requests failed (${timedOutCount} timed out)${failureDetails}`,
      duration: Date.now() - start,
      turnsCompleted: test.concurrentRequests - failedCount,
    };
  }

  for (const sid of sessionIds) {
    await deleteSession(sid);
  }

  return {
    success: true,
    duration: Date.now() - start,
    turnsCompleted: test.concurrentRequests,
  };
}

async function runMultiTurnTest(test: MultiTurnTest, timeoutOverrides: TimeoutOverrides): Promise<TestResult> {
  const start = Date.now();
  let sessionId: string | null = null;
  let turnsCompleted = 0;

  for (let index = 0; index < test.turns.length; index++) {
    const turn = test.turns[index]!;
    const prompt = typeof turn === "string" ? turn : turn.prompt;
    const model = typeof turn === "string" ? test.model : (turn.model ?? test.model);
    const turnTimeout = resolveTurnTimeout(test, turn, index, timeoutOverrides);

    process.stdout.write(`\r  Progress: ${index + 1}/${test.turns.length} turns...`);

    const result = await runTurn(
      prompt,
      model,
      sessionId ?? null,
      `regression-${test.name}`,
      turnTimeout
    );

    const combinedOutput = `${result.stderr}\n${result.output}`.toLowerCase();
    for (const pattern of test.errorPatterns) {
      if (combinedOutput.includes(pattern.toLowerCase())) {
        process.stdout.write("\r" + " ".repeat(50) + "\r");
        return {
          success: false,
          error: `Turn ${index + 1}: Found error pattern "${pattern}"`,
          duration: Date.now() - start,
          turnsCompleted,
          sessionId: sessionId ?? undefined,
        };
      }
    }

    if (result.timedOut) {
      process.stdout.write("\r" + " ".repeat(50) + "\r");
      const timeoutDiagnostic = summarizeDiagnostic(result.stderr || result.output);
      return {
        success: false,
        error: `Turn ${index + 1}: Timeout after ${turnTimeout}ms (${timeoutDiagnostic})`,
        duration: Date.now() - start,
        turnsCompleted,
        sessionId: sessionId ?? undefined,
      };
    }

    if (result.code !== 0) {
      process.stdout.write("\r" + " ".repeat(50) + "\r");
      return {
        success: false,
        error: `Turn ${index + 1}: Exit ${result.code} (${result.duration}ms) ${summarizeDiagnostic(result.stderr || result.output)}`,
        duration: Date.now() - start,
        turnsCompleted,
        sessionId: sessionId ?? undefined,
      };
    }

    sessionId = result.sessionId;
    turnsCompleted++;
  }

  process.stdout.write("\r" + " ".repeat(50) + "\r");
  return {
    success: true,
    duration: Date.now() - start,
    turnsCompleted,
    sessionId: sessionId ?? undefined,
  };
}

function parseArgs(): {
  filterName: string | null;
  filterCategory: Category | null;
  suite: TestSuite;
  dryRun: boolean;
  help: boolean;
  timeoutOverrides: TimeoutOverrides;
} {
  const args = process.argv.slice(2);
  const getArg = (flag: string): string | null => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1]! : null;
  };

  let suite: TestSuite = "all";
  if (args.includes("--sanity")) suite = "sanity";
  if (args.includes("--heavy")) suite = "heavy";

  const timeoutArg = getArg("--timeout");
  const testTimeoutSpecs = collectRepeatedArgValues(args, "--timeout-test");
  const turnTimeoutSpecs = collectRepeatedArgValues(args, "--timeout-turn");

  return {
    filterName: getArg("--test") ?? getArg("--name"),
    filterCategory: getArg("--category") as Category | null,
    suite,
    dryRun: args.includes("--dry-run"),
    help: args.includes("--help") || args.includes("-h"),
    timeoutOverrides: {
      defaultTimeout: timeoutArg !== null ? parseTimeoutMs(timeoutArg, "--timeout") : null,
      testTimeoutOverrides: parseNamedTimeoutOverrides(testTimeoutSpecs, "--timeout-test"),
      turnTimeoutOverrides: parseTurnTimeoutOverrides(turnTimeoutSpecs),
    },
  };
}

function showHelp(): void {
  console.log(`
Multi-Turn Regression Test Suite for Antigravity Plugin

Test Suites:
  --sanity    Quick tests (7 tests, ~5 min) - run frequently
  --heavy     Stress tests (4 tests, ~30 min) - long conversations
  (default)   All tests

Tests:
  Sanity (quick, repeatable):
    - thinking-tool-use, thinking-bash-tool, tool-pairing-sequential
    - opus-thinking-basic, thinking-modification-continue
    - multi-provider-switch, prompt-too-long-recovery

  Heavy (stress, endurance):
    - stress-8-turn-multi-provider (8 turns)
    - opencode-tools-comprehensive (6 turns, all tools)
    - stress-20-turn-recovery (20 turns, multi-model, recovery)
    - stress-50-turn-endurance (51 turns, endurance test)

Usage:
  npx tsx script/test-regression.ts [options]

Options:
  --sanity              Run sanity tests only (quick)
  --heavy               Run heavy tests only (stress)
  --test <name>         Run specific test by name
  --category <cat>      Run tests by category
  --timeout <ms>        Global timeout override for all tests and turns
  --timeout-test <spec> Per-test timeout override. Repeatable. Format: "<test>=<ms>"
  --timeout-turn <spec> Per-turn timeout override. Repeatable. Format: "<test>:<turn>=<ms>"
  --dry-run             List tests without running
  --help, -h            Show this help

Examples:
  npx tsx script/test-regression.ts --sanity
  npx tsx script/test-regression.ts --heavy
  npx tsx script/test-regression.ts --test stress-20-turn-recovery
  npx tsx script/test-regression.ts --timeout-test thinking-modification-continue=180000
  npx tsx script/test-regression.ts --timeout-turn thinking-modification-continue:3=240000
`);
}

async function main(): Promise<void> {
  const { filterName, filterCategory, suite, dryRun, help, timeoutOverrides } = parseArgs();

  if (help) {
    showHelp();
    return;
  }

  let tests: MultiTurnTest[];
  switch (suite) {
    case "sanity":
      tests = SANITY_TESTS;
      break;
    case "heavy":
      tests = HEAVY_TESTS;
      break;
    default:
      tests = ALL_TESTS;
  }

  if (filterName) {
    tests = tests.filter((t) => t.name === filterName);
  }
  if (filterCategory && filterCategory !== "concurrency") {
    tests = tests.filter((t) => t.category === filterCategory);
  }
  tests = applyTimeoutOverridesToTests(tests, timeoutOverrides);

  const runConcurrentOnly = filterCategory === "concurrency";
  if (runConcurrentOnly) {
    tests = [];
  }

  if (tests.length === 0 && !runConcurrentOnly) {
    console.error("No tests match the specified filters");
    process.exit(1);
  }

  const totalTurns = tests.reduce((sum, t) => sum + t.turns.length, 0);
  const concurrentCount = CONCURRENT_TESTS.reduce((sum, t) => sum + t.concurrentRequests, 0);
  console.log(`\n🧪 Regression Tests [${suite.toUpperCase()}] (${tests.length} tests, ${totalTurns} turns + ${concurrentCount} concurrent)\n${"=".repeat(60)}\n`);

  if (dryRun) {
    console.log("Tests to run:\n");
    for (const test of tests) {
      console.log(`  ${test.name} [${test.suite}]`);
      console.log(`    Model: ${test.model}`);
      console.log(`    Category: ${test.category}`);
      console.log(`    Turns: ${test.turns.length}`);
      console.log();
    }
    return;
  }

  const results: { test: MultiTurnTest; result: TestResult }[] = [];

  for (const test of tests) {
    console.log(`Testing: ${test.name} [${test.suite}]`);
    console.log(`  Model: ${test.model}`);
    console.log(`  Turns: ${test.turns.length}`);

    const result = await runMultiTurnTest(test, timeoutOverrides);
    results.push({ test, result });

    if (result.success) {
      console.log(`  Status: ✅ PASS (${result.turnsCompleted}/${test.turns.length} turns, ${(result.duration / 1000).toFixed(1)}s)`);
    } else {
      console.log(`  Status: ❌ FAIL`);
      console.log(`    Error: ${result.error}`);
      console.log(`    Completed: ${result.turnsCompleted}/${test.turns.length} turns`);
    }

    if (result.sessionId) {
      await deleteSession(result.sessionId);
    }
    console.log();
  }

  if (suite === "heavy" || suite === "all" || runConcurrentOnly || filterName) {
    let concurrentTests = applyTimeoutOverridesToConcurrentTests(CONCURRENT_TESTS, timeoutOverrides);
    if (filterName) {
      concurrentTests = concurrentTests.filter((t) => t.name === filterName);
    }
    if (concurrentTests.length === 0 && !runConcurrentOnly && tests.length === 0) {
      console.error("No tests match the specified filters");
      process.exit(1);
    }
    if (concurrentTests.length > 0) {
      console.log(`\n🔄 Concurrent Tests (${concurrentTests.length} tests)\n${"-".repeat(40)}\n`);
      for (const test of concurrentTests) {
        console.log(`Testing: ${test.name} [concurrent]`);
        console.log(`  Model: ${test.model}`);
        console.log(`  Concurrent: ${test.concurrentRequests} requests`);

        const result = await runConcurrentTest(test);
        results.push({ test: test as unknown as MultiTurnTest, result });

        if (result.success) {
          console.log(`  Status: ✅ PASS (${result.turnsCompleted} requests, ${(result.duration / 1000).toFixed(1)}s)`);
        } else {
          console.log(`  Status: ❌ FAIL`);
          console.log(`    Error: ${result.error}`);
        }
        console.log();
      }
    }
  }

  const passed = results.filter((r) => r.result.success).length;
  const failed = results.filter((r) => !r.result.success).length;
  const totalTime = results.reduce((sum, r) => sum + r.result.duration, 0);

  console.log("=".repeat(60));
  console.log(`\nSummary: ${passed} passed, ${failed} failed (${(totalTime / 1000).toFixed(1)}s total)\n`);

  if (failed > 0) {
    console.log("Failed tests:");
    for (const r of results.filter((r) => !r.result.success)) {
      console.log(`  ❌ ${r.test.name}: ${r.result.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

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
const CLAUDE_SONNET = "google/antigravity-claude-sonnet-4-5-thinking-low";
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
    timeout: 60000,
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

async function runTurn(
  prompt: string,
  model: string,
  sessionId: string | null,
  sessionTitle: string,
  timeout: number
): Promise<{ output: string; stderr: string; code: number; sessionId: string | null }> {
  return new Promise((resolve) => {
    const args = sessionId
      ? ["run", prompt, "--session", sessionId, "--model", model]
      : ["run", prompt, "--model", model, "--title", sessionTitle];

    const proc = spawn("opencode", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      proc.kill("SIGTERM");
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
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      resolve({
        output: "",
        stderr: err.message,
        code: 1,
        sessionId: null,
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
    for (const pattern of test.errorPatterns) {
      if (result.stderr.toLowerCase().includes(pattern.toLowerCase())) {
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

  const failedResults = results.filter((r) => r.code !== 0);
  const failedCount = failedResults.length;
  if (failedCount > test.concurrentRequests / 2) {
    for (const sid of sessionIds) {
      await deleteSession(sid);
    }
    const firstFailure = failedResults[0];
    const failureDetails = firstFailure
      ? `\n    First failure stderr: ${firstFailure.stderr.slice(0, 500)}`
      : "";
    return {
      success: false,
      error: `${failedCount}/${test.concurrentRequests} requests failed${failureDetails}`,
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

async function runMultiTurnTest(test: MultiTurnTest): Promise<TestResult> {
  const start = Date.now();
  let sessionId: string | null = null;
  let turnsCompleted = 0;

  for (let index = 0; index < test.turns.length; index++) {
    const turn = test.turns[index]!;
    const prompt = typeof turn === "string" ? turn : turn.prompt;
    const model = typeof turn === "string" ? test.model : (turn.model ?? test.model);
    const turnStart = Date.now();

    process.stdout.write(`\r  Progress: ${index + 1}/${test.turns.length} turns...`);

    const result = await runTurn(
      prompt,
      model,
      sessionId ?? null,
      `regression-${test.name}`,
      test.timeout
    );

    for (const pattern of test.errorPatterns) {
      if (result.stderr.toLowerCase().includes(pattern.toLowerCase())) {
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

    if (result.code !== 0 && result.code !== null) {
      const isTimeout = Date.now() - turnStart >= test.timeout - 1000;
      if (isTimeout) {
        process.stdout.write("\r" + " ".repeat(50) + "\r");
        return {
          success: false,
          error: `Turn ${index + 1}: Timeout after ${test.timeout}ms`,
          duration: Date.now() - start,
          turnsCompleted,
          sessionId: sessionId ?? undefined,
        };
      }
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
} {
  const args = process.argv.slice(2);
  const getArg = (flag: string): string | null => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] !== undefined ? args[idx + 1]! : null;
  };

  let suite: TestSuite = "all";
  if (args.includes("--sanity")) suite = "sanity";
  if (args.includes("--heavy")) suite = "heavy";

  return {
    filterName: getArg("--test") ?? getArg("--name"),
    filterCategory: getArg("--category") as Category | null,
    suite,
    dryRun: args.includes("--dry-run"),
    help: args.includes("--help") || args.includes("-h"),
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
  --dry-run             List tests without running
  --help, -h            Show this help

Examples:
  npx tsx script/test-regression.ts --sanity
  npx tsx script/test-regression.ts --heavy
  npx tsx script/test-regression.ts --test stress-20-turn-recovery
`);
}

async function main(): Promise<void> {
  const { filterName, filterCategory, suite, dryRun, help } = parseArgs();

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

    const result = await runMultiTurnTest(test);
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
    let concurrentTests = CONCURRENT_TESTS;
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

/**
 * Behavioral probe: does restoring the real Gemini-3 thoughtSignature stop the
 * model re-planning (the Loop ② symptom)?
 *
 * Controlled single-account A/B on a 2-step tool task (list_files -> read_file):
 *   Turn 1: model calls list_files, returns a thoughtSignature.
 *   Provide the file list as a functionResponse, then replay turn-2 TWO ways:
 *     - FIX arm    : functionCall carries the REAL restored signature (new plugin behavior)
 *     - SENTINEL arm: functionCall carries skip_thought_signature_validator (old behavior)
 *   Observe the model's next move each way:
 *     - read_file (or a final answer using the listing) = PROGRESSED (continuity held)
 *     - list_files again                                = RE-PLANNED (lost continuity = the loop)
 *
 * Deterministic-ish (temperature 0); runs each arm RUNS times. Uses one quota-available account.
 * Run: npx tsx script/signature-continuity-probe.ts
 */
import { loadAccounts } from "../src/plugin/storage";
import { parseRefreshParts, formatRefreshParts } from "../src/plugin/auth";
import { refreshAccessToken } from "../src/plugin/token";
import {
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  getAntigravityHeaders,
} from "../src/constants";
import type { OAuthAuthDetails, PluginClient } from "../src/plugin/types";

const MODEL = "gemini-3-flash";
const ENDPOINT = `${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`;
const SENTINEL = "skip_thought_signature_validator";
const RUNS = 2;

const PROMPT =
  "You are exploring a repo. Work step by step using the tools. " +
  "First call list_files to see what's there. After you receive the listing, " +
  "call read_file on the FIRST file in the list. Do not call list_files more than once.";

const TOOLS = [
  {
    functionDeclarations: [
      { name: "list_files", description: "List files in the repository.", parameters: { type: "object", properties: {} } },
      {
        name: "read_file",
        description: "Read the contents of one file.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ],
  },
];
const FILE_LISTING = ["alpha.md", "beta.md", "gamma.md"];

interface Account { index: number; email: string; accessToken: string; projectId: string }

async function bootstrap(acc: any, index: number): Promise<Account | null> {
  const parts = parseRefreshParts(acc.refreshToken);
  if (!parts.refreshToken) return null;
  const auth: OAuthAuthDetails = {
    type: "oauth",
    refresh: formatRefreshParts({
      refreshToken: parts.refreshToken,
      projectId: parts.projectId ?? acc.projectId,
      managedProjectId: parts.managedProjectId ?? acc.managedProjectId,
    }),
    access: "",
    expires: 0,
  };
  let refreshed: OAuthAuthDetails | undefined;
  try {
    refreshed = await refreshAccessToken(auth, {} as PluginClient, "google");
  } catch {
    return null;
  }
  if (!refreshed?.access) return null;
  const projectId =
    parts.managedProjectId ?? parts.projectId ?? acc.managedProjectId ?? acc.projectId ?? ANTIGRAVITY_DEFAULT_PROJECT_ID;
  return { index, email: acc.email ?? `account-${index}`, accessToken: refreshed.access, projectId };
}

interface TurnResult {
  status: number;
  ok: boolean;
  thoughtText: string;
  signature?: string;
  functionCalls: { name: string; args: any }[];
  errorMessage?: string;
}

async function sendTurn(account: Account, contents: any[]): Promise<TurnResult> {
  const body = {
    project: account.projectId,
    model: MODEL,
    request: {
      model: MODEL,
      contents,
      tools: TOOLS,
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0,
        thinkingConfig: { includeThoughts: true, thinkingLevel: "low" },
      },
    },
  };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      ...getAntigravityHeaders(),
      Authorization: `Bearer ${account.accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const out: TurnResult = { status: res.status, ok: res.ok, thoughtText: "", functionCalls: [] };
  if (!res.ok) {
    try {
      out.errorMessage = JSON.parse(text)?.error?.message ?? text.slice(0, 300);
    } catch {
      out.errorMessage = text.slice(0, 300);
    }
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim();
    if (!json) continue;
    let evt: any;
    try {
      evt = JSON.parse(json);
    } catch {
      continue;
    }
    const parts = (evt?.response?.candidates ?? evt?.candidates)?.[0]?.content?.parts ?? [];
    for (const p of parts) {
      if (p.thought === true && typeof p.text === "string") out.thoughtText += p.text;
      if (p.functionCall) out.functionCalls.push({ name: p.functionCall.name, args: p.functionCall.args });
      const sig = p.thoughtSignature ?? p?.metadata?.google?.thoughtSignature;
      if (sig) out.signature = sig;
    }
  }
  return out;
}

function turn2History(t1: TurnResult, sig: string): any[] {
  const modelParts: any[] = [];
  if (t1.thoughtText) modelParts.push({ thought: true, text: t1.thoughtText, thoughtSignature: sig });
  modelParts.push({ functionCall: { name: "list_files", args: {} }, thoughtSignature: sig });
  return [
    { role: "user", parts: [{ text: PROMPT }] },
    { role: "model", parts: modelParts },
    { role: "user", parts: [{ functionResponse: { name: "list_files", response: { files: FILE_LISTING } } }] },
  ];
}

function classifyMove(r: TurnResult): { label: string; progressed: boolean | null } {
  if (!r.ok) return { label: `HTTP ${r.status} (${r.errorMessage})`, progressed: null };
  const names = r.functionCalls.map((f) => f.name);
  if (names.includes("read_file")) {
    const fc = r.functionCalls.find((f) => f.name === "read_file");
    return { label: `read_file(${JSON.stringify(fc?.args)}) → PROGRESSED ✅`, progressed: true };
  }
  if (names.includes("list_files")) return { label: "list_files AGAIN → RE-PLANNED ❌", progressed: false };
  if (names.length === 0) return { label: "no tool call (text answer) → progressed (used listing) ✅", progressed: true };
  return { label: `other: ${names.join(",")}`, progressed: null };
}

async function main() {
  console.log("=== Gemini-3 signature continuity probe (FIX vs SENTINEL) ===\n");
  const storage = await loadAccounts();
  const raw = (storage?.accounts ?? []).filter((a: any) => a.enabled !== false);
  const accounts: Account[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = await bootstrap(raw[i], i);
    if (a) accounts.push(a);
  }
  console.log(`Bootstrapped ${accounts.length} account(s).`);

  // Turn 1: find an account whose first move is list_files + returns a signature.
  let acct: Account | undefined;
  let t1: TurnResult | undefined;
  for (const cand of accounts) {
    const r = await sendTurn(cand, [{ role: "user", parts: [{ text: PROMPT }] }]);
    if (r.status === 429) {
      console.log(`  [${cand.index}] ${cand.email}: 429 quota — skip`);
      continue;
    }
    if (r.ok && r.signature && r.functionCalls.some((f) => f.name === "list_files")) {
      acct = cand;
      t1 = r;
      console.log(`  ✓ account [${cand.index}] ${cand.email}; turn-1 → list_files, signature ${r.signature.length} chars`);
      break;
    }
    console.log(`  [${cand.index}] ${cand.email}: turn-1 unsuitable (ok=${r.ok}, sig=${!!r.signature}, calls=${r.functionCalls.map((f) => f.name).join(",") || "none"}) — skip`);
  }
  if (!acct || !t1 || !t1.signature) {
    console.log("\nINCONCLUSIVE — no quota-available account produced a turn-1 list_files+signature.");
    process.exit(3);
  }

  const realSig = t1.signature;
  const fixHistory = turn2History(t1, realSig);
  const sentinelHistory = turn2History(t1, SENTINEL);

  const tally = { fix: { progressed: 0, replanned: 0, other: 0 }, sentinel: { progressed: 0, replanned: 0, other: 0 } };

  for (let run = 1; run <= RUNS; run++) {
    console.log(`\n--- Run ${run}/${RUNS} ---`);
    const fix = classifyMove(await sendTurn(acct, fixHistory));
    console.log(`  FIX (real signature):      ${fix.label}`);
    if (fix.progressed === true) tally.fix.progressed++;
    else if (fix.progressed === false) tally.fix.replanned++;
    else tally.fix.other++;

    const sen = classifyMove(await sendTurn(acct, sentinelHistory));
    console.log(`  SENTINEL (old behavior):   ${sen.label}`);
    if (sen.progressed === true) tally.sentinel.progressed++;
    else if (sen.progressed === false) tally.sentinel.replanned++;
    else tally.sentinel.other++;
  }

  console.log("\n=== TALLY (over", RUNS, "runs) ===");
  console.log(`  FIX (real sig):  progressed=${tally.fix.progressed} replanned=${tally.fix.replanned} other=${tally.fix.other}`);
  console.log(`  SENTINEL (old):  progressed=${tally.sentinel.progressed} replanned=${tally.sentinel.replanned} other=${tally.sentinel.other}`);
  console.log("\n=== INTERPRETATION ===");
  if (tally.fix.progressed > 0 && tally.sentinel.replanned > 0 && tally.fix.replanned === 0) {
    console.log("✅ CONFIRMED: real signature progresses; sentinel re-plans. The fix resolves the loop.");
  } else if (tally.fix.progressed === RUNS && tally.sentinel.progressed === RUNS) {
    console.log("↔️  Both arms progressed in this short probe — no divergence observed at 2 turns.");
    console.log("    (The fix still restores real signatures vs. the sentinel; the loop may need more turns/context to surface. Cross-project safety already proven by the A/B test.)");
  } else {
    console.log("⚠️  Mixed/partial result — see per-run lines above; model nondeterminism may require more runs.");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

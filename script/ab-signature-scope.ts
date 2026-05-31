/**
 * Live A/B test: is a Gemini-3 `thoughtSignature` portable across GCP projects/accounts?
 *
 * Decides whether Defect 2 (dropping projectId from the Gemini-3 signature cache
 * key) is SAFE. Procedure:
 *   1. Bootstrap all OAuth accounts (refresh tokens, resolve projects).
 *   2. Find A: first account whose Gemini-3 thinking+tool request returns a thoughtSignature.
 *   3. Control A→A: replay A's signature in history under A (same project) → expect 200.
 *   4. Test A→B: replay A's signature under each OTHER account with a DIFFERENT project,
 *      skipping quota-exhausted (429) ones until a conclusive result:
 *        - 200            → accepted cross-project → dropping projectId is SAFE.
 *        - 400 (signature) → project-scoped → switch Defect 2 to strip-on-miss.
 *      If every candidate is 429 → INCONCLUSIVE (rerun when quota resets).
 *
 * Makes several real authenticated calls and consumes a little Gemini-3 quota.
 * Run: npx tsx script/ab-signature-scope.ts
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
const PROMPT = "Use the multiply tool to compute 17 times 23. You must call the tool.";
const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "multiply",
        description: "Multiply two integers and return the product.",
        parameters: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
    ],
  },
];

interface Account {
  index: number;
  email: string;
  accessToken: string;
  projectId: string;
}

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
  } catch (e) {
    console.log(`  account[${index}] ${acc.email ?? "?"}: token refresh failed: ${String(e)}`);
    return null;
  }
  if (!refreshed?.access) return null;
  const projectId =
    parts.managedProjectId ??
    parts.projectId ??
    acc.managedProjectId ??
    acc.projectId ??
    ANTIGRAVITY_DEFAULT_PROJECT_ID;
  return { index, email: acc.email ?? `account-${index}`, accessToken: refreshed.access, projectId };
}

interface TurnResult {
  status: number;
  ok: boolean;
  parts: any[];
  signature?: string;
  functionCall?: any;
  thoughtText: string;
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
  const out: TurnResult = { status: res.status, ok: res.ok, parts: [], thoughtText: "" };
  if (!res.ok) {
    try {
      out.errorMessage = JSON.parse(text)?.error?.message ?? text.slice(0, 500);
    } catch {
      out.errorMessage = text.slice(0, 500);
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
      out.parts.push(p);
      if (p.thought === true && typeof p.text === "string") out.thoughtText += p.text;
      if (p.functionCall) out.functionCall = p.functionCall;
      const sig = p.thoughtSignature ?? p?.metadata?.google?.thoughtSignature;
      if (sig) out.signature = sig;
    }
  }
  return out;
}

function buildReplayHistory(t1: TurnResult): any[] {
  const sig = t1.signature!;
  const modelParts: any[] = [];
  if (t1.thoughtText) modelParts.push({ thought: true, text: t1.thoughtText, thoughtSignature: sig });
  if (t1.functionCall) {
    modelParts.push({ functionCall: t1.functionCall, thoughtSignature: sig });
    return [
      { role: "user", parts: [{ text: PROMPT }] },
      { role: "model", parts: modelParts },
      {
        role: "user",
        parts: [{ functionResponse: { name: t1.functionCall.name, response: { result: 391 } } }],
      },
    ];
  }
  modelParts.push({ text: "391" });
  return [
    { role: "user", parts: [{ text: PROMPT }] },
    { role: "model", parts: modelParts },
    { role: "user", parts: [{ text: "Now multiply that result by 2." }] },
  ];
}

type Verdict = "ok" | "sig-reject" | "quota" | "other";
function classify(label: string, r: TurnResult): Verdict {
  if (r.ok) {
    console.log(`  ${label}: HTTP ${r.status} ✅ accepted`);
    return "ok";
  }
  if (r.status === 429) {
    console.log(`  ${label}: HTTP 429 (quota) — ${r.errorMessage}`);
    return "quota";
  }
  const msg = (r.errorMessage ?? "").toLowerCase();
  const sigRelated = msg.includes("signature") || msg.includes("thinking") || msg.includes("thought");
  console.log(`  ${label}: HTTP ${r.status} ❌ ${sigRelated ? "[SIGNATURE-RELATED] " : ""}${r.errorMessage}`);
  return sigRelated ? "sig-reject" : "other";
}

async function main() {
  console.log("=== Gemini-3 thoughtSignature cross-project A/B test ===\n");
  const storage = await loadAccounts();
  const raw = (storage?.accounts ?? []).filter((a: any) => a.enabled !== false);
  console.log(`Loaded ${raw.length} enabled account(s). Bootstrapping (refresh + project)...`);
  const accounts: Account[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = await bootstrap(raw[i], i);
    if (a) {
      console.log(`  ✓ [${a.index}] ${a.email} → project ${a.projectId}`);
      accounts.push(a);
    }
  }
  if (accounts.length < 2) {
    console.log("Need at least 2 usable accounts. Aborting.");
    process.exit(2);
  }

  // Find A: first account that returns a signature (has quota + thinking).
  console.log("\n[Turn 1] Finding an account with quota to elicit a signature...");
  let A: Account | undefined;
  let t1: TurnResult | undefined;
  for (const cand of accounts) {
    const r = await sendTurn(cand, [{ role: "user", parts: [{ text: PROMPT }] }]);
    if (r.status === 429) {
      console.log(`  [${cand.index}] ${cand.email}: 429 quota — skip`);
      continue;
    }
    if (!r.ok) {
      console.log(`  [${cand.index}] ${cand.email}: HTTP ${r.status} ${r.errorMessage} — skip`);
      continue;
    }
    if (!r.signature) {
      console.log(`  [${cand.index}] ${cand.email}: 200 but no signature — skip`);
      continue;
    }
    A = cand;
    t1 = r;
    console.log(`  ✓ A=[${cand.index}] ${cand.email} (project ${cand.projectId}); signature ${r.signature.length} chars, fnCall=${!!r.functionCall}`);
    break;
  }
  if (!A || !t1) {
    console.log("\nVERDICT: INCONCLUSIVE — no account had quota to produce a signature. Rerun when Gemini-3 quota resets.");
    process.exit(3);
  }

  const history = buildReplayHistory(t1);

  console.log("\n[Control A→A] replay A's signature under A (same project)...");
  const ctrl = classify("A→A", await sendTurn(A, history));

  console.log("\n[Test A→B] replay A's signature under other accounts with a DIFFERENT project...");
  let test: Verdict | undefined;
  let B: Account | undefined;
  for (const cand of accounts) {
    if (cand.index === A.index) continue;
    if (cand.projectId === A.projectId) {
      console.log(`  [${cand.index}] ${cand.email}: same project as A — skip`);
      continue;
    }
    const v = classify(`A→[${cand.index}] ${cand.email}`, await sendTurn(cand, history));
    if (v === "quota") continue; // try the next candidate
    test = v;
    B = cand;
    break;
  }

  console.log("\n=== VERDICT ===");
  if (ctrl === "quota") {
    console.log("INCONCLUSIVE — A→A control hit quota.");
    process.exit(3);
  }
  if (ctrl !== "ok") {
    console.log(`INCONCLUSIVE — A→A control did not succeed (${ctrl}); cannot isolate the cross-project variable.`);
    process.exit(3);
  }
  if (!test || !B) {
    console.log("INCONCLUSIVE — no second account had quota AND a different project. Rerun when Gemini-3 quota resets.");
    process.exit(3);
  }
  console.log(`A = ${A.email} (project ${A.projectId})  →  B = ${B.email} (project ${B.projectId})`);
  if (test === "ok") {
    console.log("PORTABLE ✅ — A's signature was accepted under B's project. Dropping projectId (Defect 2) is SAFE.");
  } else if (test === "sig-reject") {
    console.log("PROJECT-SCOPED ❌ — B rejected A's signature (signature/thinking error). Switch Defect 2 to strip-on-miss.");
  } else {
    console.log("UNCLEAR — A→B returned a non-signature error; inspect the message above.");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

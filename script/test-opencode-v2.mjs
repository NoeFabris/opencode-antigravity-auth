import { spawn } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const binary = process.env.OPENCODE_BIN ?? "opencode"
const packagePath = resolve(process.argv[2] ?? root)
const authMode = process.env.OPENCODE_V2_TEST_AUTH ?? "legacy"
if (!["legacy", "pool", "v2"].includes(authMode)) throw new Error(`Unknown fixture auth mode: ${authMode}`)
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "antigravity-v2-runtime-")))
const config = join(temporary, "config", "opencode")
const workspace = join(temporary, "workspace")
const logPath = join(temporary, "requests.jsonl")
const fixturePackage = join(temporary, "fixture-plugin")
mkdirSync(config, { recursive: true })
mkdirSync(workspace)
mkdirSync(fixturePackage)
copyFileSync(join(root, "script", "fixtures", "opencode-v2-plugin.mjs"), join(fixturePackage, "index.js"))
writeFileSync(join(fixturePackage, "package.json"), JSON.stringify({ name: "antigravity-runtime-fixture", type: "module", main: "index.js" }))
writeFileSync(logPath, "")
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(temporary, "config"),
  XDG_DATA_HOME: join(temporary, "data"),
  XDG_CACHE_HOME: join(temporary, "cache"),
  XDG_STATE_HOME: join(temporary, "state"),
  OPENCODE_CONFIG_DIR: config,
  ANTIGRAVITY_FIXTURE_LOG: logPath,
  ANTIGRAVITY_FIXTURE_ROOT: temporary,
  ANTIGRAVITY_FIXTURE_AUTH: authMode,
  // A developer's Google environment key must not replace the synthetic grant.
  GOOGLE_API_KEY: "",
  GOOGLE_GENERATIVE_AI_API_KEY: "",
  GEMINI_API_KEY: "",
}
// Deliberately synthetic credentials; never read the user's account files.
writeFileSync(join(config, "antigravity-accounts.json"), JSON.stringify({
  version: 4,
  accounts: [{ refreshToken: "fixture-refresh-token", projectId: "fixture-project", managedProjectId: "fixture-project", addedAt: 1, lastUsed: 0, enabled: true }],
  activeIndex: 0,
}), { mode: 0o600 })
writeFileSync(join(config, "antigravity.json"), JSON.stringify({ proactive_token_refresh: false, auto_update: false, quiet_mode: true }))
// The fixture seeds V2's actual credential table inside the Bun CLI. Merely
// writing V1 auth.json does not prove that the runtime imported a credential.
writeFileSync(join(config, "opencode.json"), JSON.stringify({
  plugins: [fixturePackage, packagePath],
  update: "disable",
  snapshots: false,
}))

async function run(args, timeoutMs = 60_000) {
  return new Promise((accept, reject) => {
    const child = spawn(binary, args, { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
    let output = ""
    let errors = ""
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGTERM") } catch { /* Already exited. */ }
      reject(new Error(`OpenCode timed out. ${errors.slice(-3000)}`))
    }, timeoutMs)
    child.stdout.on("data", (chunk) => { output += chunk })
    child.stderr.on("data", (chunk) => { errors += chunk })
    child.on("error", (error) => { clearTimeout(timer); reject(error) })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`OpenCode exited ${code}. ${errors.slice(-4000)} ${output.slice(-2000)}`))
      else accept({ output, errors })
    })
  })
}

try {
  const version = await run(["--version"])
  if (!/\bv?2\./.test(version.output)) throw new Error(`Expected OpenCode V2, got ${version.output.trim()}`)
  console.log(`Runtime: ${version.output.trim()}; auth: ${authMode}`)
  const catalog = await run(["models", "--standalone"])
  const modelIDs = catalog.output.split("\n").map(line => line.trim()).filter(line => line.startsWith("google/"))
  if (!modelIDs.some(id => id.startsWith("google/antigravity-"))) throw new Error("Antigravity models are missing from the picker")
  if (authMode !== "pool" && modelIDs.some(id => !id.startsWith("google/antigravity-"))) {
    throw new Error("Antigravity OAuth exposes native Google models that require an API key")
  }
  console.log("PASS Google model catalog matches the active authentication method")
  // Keep the inference evidence below limited to its four independent runs.
  writeFileSync(logPath, "")
  const tests = [
    { model: "google/antigravity-gemini-3-flash#high", tool: false },
    { model: "google/antigravity-claude-opus-4-6-thinking#max", tool: false },
    { model: "google/antigravity-gemini-3-flash#high", tool: true },
    { model: "google/antigravity-claude-opus-4-6-thinking#max", tool: true },
  ]
  for (const test of tests) {
    const firstRecord = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length
    const prompt = test.tool ? "fixture-tool: call fixture_echo, then answer TOOL_ROUND_TRIP_OK" : "Reply PLUGIN_V2_OK"
    const result = await run(["run", "--standalone", "--auto", "--format", "json", "--model", test.model, prompt])
    const marker = test.tool ? "TOOL_ROUND_TRIP_OK" : "PLUGIN_V2_OK"
    const events = result.output.trim().split("\n").map((line) => JSON.parse(line))
    if (events.some((event) => event.type === "error") || !events.some((event) => event.type === "text" && event.part?.text?.includes(marker))) {
      throw new Error(`Model did not produce assistant text ${marker}: ${result.output.slice(-2000)} ${result.errors.slice(-2000)}`)
    }
    const records = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).slice(firstRecord).map((line) => JSON.parse(line))
    const count = authMode === "pool" ? 0 : 1
    const methodID = authMode === "legacy" ? "oauth" : authMode === "v2" ? "antigravity" : null
    if (records.filter((record) => record.kind === "fixture-setup").length !== 1) throw new Error("Each CLI case must load the fixture exactly once")
    for (const kind of ["credential-seeded", "credential-effective"]) {
      const proof = records.filter((record) => record.kind === kind)
      if (proof.length !== 1 || proof[0].mode !== authMode || proof[0].credentialCount !== count || proof[0].methodID !== methodID
        || proof[0].type !== (count ? "oauth" : null) || proof[0].connectionType !== (count ? "credential" : null)
        || proof[0].active !== Boolean(count) || proof[0].synthetic !== true || (kind === "credential-seeded" && count && !proof[0].expired)
        || (kind === "credential-effective" && authMode === "v2" && proof[0].expired)) {
        throw new Error(`Missing actual V2 ${kind} proof for ${authMode}`)
      }
    }
    if (!records.some((record) => record.kind === "oauth-refresh" && record.synthetic === true)) throw new Error("Expired synthetic OAuth token was not refreshed")
    console.log(`PASS ${test.model}${test.tool ? " tool round trip" : " streaming + variant"}`)
    console.log(`PASS ${authMode} credential: count=${count}; methodID=${methodID ?? "none"}; active/resolve verified; synthetic OAuth refreshed`)
  }
  const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
  const requests = records.filter((record) => record.kind === "request")
  if (records.filter((record) => record.kind === "fixture-setup").length !== 4) throw new Error("Expected exactly four CLI fixture setups")
  if (records.filter((record) => record.kind === "tool" && record.value === "tool-round-trip").length !== 2) throw new Error("Both model families must execute the tool")
  if (!requests.some((record) => record.model.includes("gemini") && record.generationConfig?.thinkingConfig?.thinkingLevel?.toLowerCase() === "high")) throw new Error("Gemini variant was lost")
  if (!requests.some((record) => record.model.includes("claude") && record.generationConfig?.thinkingConfig?.thinking_budget === 32768)) throw new Error("Claude variant was lost")
  if (requests.filter((record) => record.toolReturned).length < 2) throw new Error("Tool results did not return to both model families")
  console.log(`PASS ${requests.length} fixture transport requests; API key stripping, Hub identity, and daily endpoint checked`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  if (process.env.KEEP_OPENCODE_V2_FIXTURE) console.log(`Runtime evidence: ${temporary}`)
  else rmSync(temporary, { recursive: true, force: true })
}

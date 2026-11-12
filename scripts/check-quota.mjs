import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const CLOUD_CODE_BASE = "https://daily-cloudcode-pa.googleapis.com";
const USER_AGENT = "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)";
const FALLBACK_PROJECT_ID = "bamboo-precept-lgxtn";

function getDefaultAccountsPath() {
  if (process.env.OPENCODE_CONFIG_DIR) return join(process.env.OPENCODE_CONFIG_DIR, "antigravity-accounts.json");
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "opencode", "antigravity-accounts.json");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode", "antigravity-accounts.json");
}

function parseArgs() {
  const args = process.argv.slice(2);
  let path = getDefaultAccountsPath();
  let accountIndex = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--path" && args[i + 1]) {
      path = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--account" && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1], 10);
      if (!Number.isNaN(parsed)) {
        accountIndex = parsed - 1;
      }
      i += 1;
    }
  }
  return { path, accountIndex };
}

async function postJson(url, token, body, extraHeaders = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token refresh failed (${response.status}): ${text.slice(0, 200)}`);
  }

  const payload = await response.json();
  return payload.access_token;
}

async function loadProjectId(accessToken) {
  const body = { metadata: { ideType: "ANTIGRAVITY" } };
  const response = await postJson(`${CLOUD_CODE_BASE}/v1internal:loadCodeAssist`, accessToken, body);
  if (!response.ok) {
    return "";
  }
  const payload = await response.json();
  if (typeof payload.cloudaicompanionProject === "string") {
    return payload.cloudaicompanionProject;
  }
  if (payload.cloudaicompanionProject && typeof payload.cloudaicompanionProject.id === "string") {
    return payload.cloudaicompanionProject.id;
  }
  return "";
}

function classifyGroup(modelName) {
  const lower = modelName.toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (!lower.includes("gemini")) return null;
  if (lower.includes("flash")) return "gemini-flash";
  return "gemini-pro";
}

function updateGroup(groups, group, remainingFraction, resetTime) {
  const entry = groups[group] || { count: 0 };
  entry.count += 1;
  if (typeof remainingFraction === "number") {
    if (entry.remaining === undefined) {
      entry.remaining = remainingFraction;
    } else {
      entry.remaining = Math.min(entry.remaining, remainingFraction);
    }
  }
  if (resetTime) {
    const timestamp = Date.parse(resetTime);
    if (Number.isFinite(timestamp)) {
      if (!entry.resetTime) {
        entry.resetTime = resetTime;
      } else {
        const existing = Date.parse(entry.resetTime);
        if (!Number.isFinite(existing) || timestamp < existing) {
          entry.resetTime = resetTime;
        }
      }
    }
  }
  groups[group] = entry;
}

function formatDuration(targetTime) {
  const delta = targetTime - Date.now();
  if (delta <= 0) return "now";
  const totalSeconds = Math.round(delta / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function createProgressBar(fraction, width = 34) {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) {
    return `[\x1b[2m${"░".repeat(width)}\x1b[0m] ???%`;
  }
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const color = clamped >= 0.6 ? "\x1b[32m" : clamped >= 0.2 ? "\x1b[33m" : "\x1b[31m";
  return `[${color}${"█".repeat(filled)}\x1b[0m\x1b[2m${"░".repeat(empty)}\x1b[0m] ${(clamped * 100).toFixed(2)}%`;
}

function formatCountdown(resetTime, remainingFraction) {
  if (typeof remainingFraction === "number" && remainingFraction >= 1) {
    return "\x1b[32mQuota available\x1b[0m";
  }
  if (!resetTime) {
    return remainingFraction === 0 ? "\x1b[31mExhausted\x1b[0m" : "\x1b[32mQuota available\x1b[0m";
  }
  const target = Date.parse(resetTime);
  if (!Number.isFinite(target)) return "\x1b[32mQuota available\x1b[0m";
  const diff = target - Date.now();
  if (diff <= 0) return "\x1b[33mReset due\x1b[0m";
  const mins = Math.max(1, Math.ceil(diff / 60000));
  const hours = Math.floor(mins / 60);
  const m = mins % 60;
  const duration = hours > 0 ? `${hours}h ${m}m` : `${m}m`;
  const color = remainingFraction !== undefined && remainingFraction >= 0.6 ? "\x1b[32m" : remainingFraction !== undefined && remainingFraction < 0.2 ? "\x1b[31m" : "\x1b[33m";
  return `${color}Refreshes in ${duration}\x1b[0m`;
}

function printGroup(label, entry) {
  if (!entry || entry.count === 0) return;
  const remaining = typeof entry.remaining === "number" ? Math.round(entry.remaining * 100) : null;
  const status = remaining === null ? "UNKNOWN" : remaining <= 0 ? "LIMITED" : "OK";
  const details = [];
  if (remaining !== null) details.push(`remaining ${remaining}%`);
  if (entry.resetTime) {
    const time = formatDuration(Date.parse(entry.resetTime));
    details.push(`resets in ${time}`);
  }
  const suffix = details.length ? ` (${details.join(", ")})` : "";
  console.log(`   ${label}: ${status}${suffix}`);
}

async function run() {
  const { path, accountIndex } = parseArgs();
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const accounts = payload.accounts || [];

  if (accounts.length === 0) {
    console.log("No accounts found.");
    return;
  }

  const selected = accountIndex === null
    ? accounts.map((account, index) => ({ account, index }))
    : accounts
      .map((account, index) => ({ account, index }))
      .filter((item) => item.index === accountIndex);

  for (const { account, index } of selected) {
    const label = account.email || `Account ${index + 1}`;
    const disabled = account.enabled === false ? " (disabled)" : "";
    console.log(`\n${index + 1}. ${label}${disabled}`);

    try {
      const accessToken = await refreshAccessToken(account.refreshToken);
      let projectId = await loadProjectId(accessToken);
      if (!projectId) {
        projectId = account.managedProjectId || account.projectId || FALLBACK_PROJECT_ID;
      }
      console.log(`   project: ${projectId}`);

      const body = projectId ? { project: projectId } : {};
      const [response, summaryResponse] = await Promise.all([
        postJson(`${CLOUD_CODE_BASE}/v1internal:fetchAvailableModels`, accessToken, body),
        postJson(`${CLOUD_CODE_BASE}/v1internal:retrieveUserQuotaSummary`, accessToken, body).catch(() => null),
      ]);
      console.log(`   fetchAvailableModels: ${response.status}`);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.log(`   error: ${text.trim().slice(0, 200)}`);
        continue;
      }

      const summaryData = summaryResponse && summaryResponse.ok ? await summaryResponse.json().catch(() => null) : null;
      if (summaryData && Array.isArray(summaryData.groups) && summaryData.groups.length > 0) {
        for (const group of summaryData.groups) {
          if (!group || !Array.isArray(group.buckets)) continue;
          const lower = (group.displayName || "").toLowerCase();
          let title = (group.displayName || "QUOTA").toUpperCase();
          let subtitle = group.description || "";
          if (lower.includes("gemini") && !lower.includes("argon")) {
            title = "GEMINI MODELS";
            subtitle ||= "Models within this group: Gemini Flash, Gemini Pro";
          } else if (lower.includes("claude") || lower.includes("3p") || lower.includes("gpt")) {
            title = "CLAUDE AND GPT MODELS";
            subtitle ||= "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS";
          }
          const buckets = group.buckets.filter((b) => b && !b.disabled);
          if (buckets.length === 0) continue;
          console.log(`\n\x1b[1m\x1b[36m${title}\x1b[0m`);
          if (subtitle) console.log(`  \x1b[2m${subtitle}\x1b[0m\n`);
          for (const b of buckets) {
            const winRaw = (b.window || "").toLowerCase();
            const idRaw = (b.bucketId || "").toLowerCase();
            const label = winRaw === "weekly" || idRaw.includes("weekly")
              ? "Weekly Limit Remaining"
              : winRaw === "5h" || idRaw.includes("5h")
                ? "Five Hour Limit Remaining"
                : b.displayName || "Limit Remaining";
            const rf = typeof b.remainingFraction === "number" ? b.remainingFraction : 0;
            console.log(`  ${label}`);
            console.log(`    ${createProgressBar(rf)}`);
            console.log(`    ${formatCountdown(b.resetTime, rf)}\n`);
          }
        }
        continue;
      }

      const data = await response.json();
      const groups = {};
      const models = data.models || {};
      for (const [modelName, info] of Object.entries(models)) {
        const group = classifyGroup(modelName);
        if (!group) continue;
        if (!info || !info.quotaInfo) continue;
        const remaining = info.quotaInfo.remainingFraction ?? 0;
        updateGroup(groups, group, remaining, info.quotaInfo.resetTime);
      }

      const claude = groups["claude"];
      const geminiPro = groups["gemini-pro"];
      const geminiFlash = groups["gemini-flash"];

      if (geminiFlash || geminiPro) {
        console.log(`\n\x1b[1m\x1b[36mGEMINI MODELS\x1b[0m`);
        console.log(`  \x1b[2mModels within this group: Gemini Flash, Gemini Pro\x1b[0m\n`);
        if (geminiFlash) {
          console.log(`  Weekly Limit Remaining`);
          console.log(`    ${createProgressBar(geminiFlash.remaining)}`);
          console.log(`    ${formatCountdown(geminiFlash.resetTime, geminiFlash.remaining)}\n`);
        }
        if (geminiPro) {
          console.log(`  Five Hour Limit Remaining`);
          console.log(`    ${createProgressBar(geminiPro.remaining)}`);
          console.log(`    ${formatCountdown(geminiPro.resetTime, geminiPro.remaining)}\n`);
        }
      }

      if (claude) {
        console.log(`\x1b[1m\x1b[36mCLAUDE AND GPT MODELS\x1b[0m`);
        console.log(`  \x1b[2mModels within this group: Claude Opus, Claude Sonnet\x1b[0m\n`);
        console.log(`  Weekly Limit Remaining`);
        console.log(`    ${createProgressBar(claude.remaining)}`);
        console.log(`    ${formatCountdown(claude.resetTime, claude.remaining)}\n`);
        console.log(`  Five Hour Limit Remaining`);
        console.log(`    ${createProgressBar(claude.remaining >= 1 ? 1 : claude.remaining)}`);
        console.log(`    ${formatCountdown(claude.remaining >= 1 ? undefined : claude.resetTime, claude.remaining)}\n`);
      }
    } catch (error) {
      console.log(`   error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

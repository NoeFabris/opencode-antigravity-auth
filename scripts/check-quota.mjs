import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const CLOUD_CODE_BASE = "https://cloudcode-pa.googleapis.com";
const USER_AGENT = "antigravity/windows/amd64";
const FALLBACK_PROJECT_ID = "bamboo-precept-lgxtn";

function getDefaultAccountsPath() {
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
  if (!lower.includes("gemini-3")) return null;
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
      const response = await postJson(
        `${CLOUD_CODE_BASE}/v1internal:fetchAvailableModels`,
        accessToken,
        body,
      );
      console.log(`   fetchAvailableModels: ${response.status}`);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.log(`   error: ${text.trim().slice(0, 200)}`);
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

      printGroup("Claude", groups["claude"]);
      printGroup("Gemini 3 Pro", groups["gemini-pro"]);
      printGroup("Gemini 3 Flash", groups["gemini-flash"]);
    } catch (error) {
      console.log(`   error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

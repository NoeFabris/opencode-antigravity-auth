/**
 * Remote Antigravity version fetcher.
 *
 * Mirrors the Antigravity-Manager's version resolution strategy, with an
 * additional first step that detects the locally installed `agy` binary:
 *   1. Local `agy --version` (most accurate — reflects installed CLI)
 *   2. Auto-updater API (plain text with semver)
 *   3. Changelog page scrape (first 5000 chars)
 *   4. Hardcoded fallback in constants.ts
 *
 * Called once at plugin startup to ensure headers use the latest
 * supported version, avoiding "version no longer supported" errors.
 *
 * @see https://github.com/lbjlaq/Antigravity-Manager (src-tauri/src/constants.rs)
 */

import { execFile } from "node:child_process";
import { getAntigravityVersion, setAntigravityVersion } from "../constants";
import { createLogger } from "./logger";

const VERSION_URL = "https://antigravity-auto-updater-974169037036.us-central1.run.app";
const CHANGELOG_URL = "https://antigravity.google/changelog";
const FETCH_TIMEOUT_MS = 5000;
const CHANGELOG_SCAN_CHARS = 5000;
const VERSION_REGEX = /\d+\.\d+\.\d+/;
const AGY_BINARY_TIMEOUT_MS = 2000;

// Candidate paths for the official agy binary, in priority order.
// Prefer the explicit local path first (matches agy-cli.ts detection order).
const AGY_CANDIDATES = [
  `${process.env["HOME"] ?? ""}/.local/bin/agy`,
  "agy",
];

type VersionSource = "local-agy" | "api" | "changelog" | "fallback";

function parseVersion(text: string): string | null {
  const match = text.match(VERSION_REGEX);
  return match ? match[0] : null;
}

/**
 * Try to detect the version of the locally installed `agy` binary.
 * Runs `agy --version` with a short timeout and parses the semver output.
 * Returns null if the binary is not found or times out.
 */
function tryLocalAgyVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result: string | null) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    const timer = setTimeout(() => done(null), AGY_BINARY_TIMEOUT_MS);

    const tryNext = (candidates: string[]): void => {
      if (candidates.length === 0) {
        clearTimeout(timer);
        done(null);
        return;
      }
      const [candidate, ...rest] = candidates;
      execFile(candidate!, ["--version"], { timeout: AGY_BINARY_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) {
          tryNext(rest);
          return;
        }
        const version = parseVersion((stdout || stderr).trim());
        clearTimeout(timer);
        done(version);
      });
    };

    tryNext(AGY_CANDIDATES);
  });
}

async function tryFetchVersion(url: string, maxChars?: number): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    let text = await response.text();
    if (maxChars) text = text.slice(0, maxChars);
    return parseVersion(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch the latest Antigravity version and update the global constant.
 * Safe to call before logger is initialized (will silently skip logging).
 */
export async function initAntigravityVersion(): Promise<void> {
  const log = createLogger("version");
  const fallback = getAntigravityVersion();
  let version: string | null;
  let source: VersionSource;

  // 1. Try local agy binary (most accurate — reflects what's actually installed)
  version = await tryLocalAgyVersion();
  if (version) {
    source = "local-agy";
  } else {
    // 2. Try auto-updater API
    version = await tryFetchVersion(VERSION_URL);
    if (version) {
      source = "api";
    } else {
      // 3. Try changelog page scrape
      version = await tryFetchVersion(CHANGELOG_URL, CHANGELOG_SCAN_CHARS);
      if (version) {
        source = "changelog";
      } else {
        // 4. Fall back to hardcoded
        source = "fallback";
        setAntigravityVersion(fallback);
        log.info("version-fetch-failed", { fallback });
        return;
      }
    }
  }

  if (version !== fallback) {
    log.info("version-updated", { version, source, previous: fallback });
  } else {
    log.debug("version-unchanged", { version, source });
  }
  setAntigravityVersion(version);
}

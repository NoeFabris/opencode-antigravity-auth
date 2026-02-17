/**
 * Device Fingerprint Generator for Rate Limit Mitigation
 *
 * Ported from antigravity-claude-proxy PR #170
 * https://github.com/badrisnarayanan/antigravity-claude-proxy/pull/170
 *
 * Generates randomized device fingerprints to help distribute API usage
 * across different apparent device identities.
 */

import * as crypto from "node:crypto";
import * as os from "node:os";
import { getAntigravityVersion } from "../constants";

const OS_VERSIONS: Record<string, string[]> = {
  darwin: ["10.15.7", "11.6.8", "12.6.3", "13.5.2", "14.2.1", "14.5"],
  win32: ["10.0.19041", "10.0.19042", "10.0.19043", "10.0.22000", "10.0.22621", "10.0.22631"],
  linux: ["5.15.0", "5.19.0", "6.1.0", "6.2.0", "6.5.0", "6.6.0"],
};

const ARCHITECTURES = ["x64", "arm64"];

const IDE_TYPES = [
  "ANTIGRAVITY",
] as const;

const PLATFORMS = [
  "WINDOWS",
  "MACOS",
] as const;

const SDK_CLIENTS = [
  "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "google-cloud-sdk vscode/1.86.0",
  "google-cloud-sdk vscode/1.87.0",
  "google-cloud-sdk vscode/1.96.0",
];

export interface ClientMetadata {
  ideType: string;
  platform: string;
  pluginType: string;
}

export interface Fingerprint {
  deviceId: string;
  sessionToken: string;
  userAgent: string;
  apiClient: string;
  clientMetadata: ClientMetadata;
  createdAt: number;
  /** @deprecated Kept for backward compat with stored fingerprints */
  quotaUser?: string;
}

/**
 * Fingerprint version for history tracking.
 * Stores a snapshot of a fingerprint with metadata about when/why it was saved.
 */
export interface FingerprintVersion {
  fingerprint: Fingerprint;
  timestamp: number;
  reason: 'initial' | 'regenerated' | 'restored';
}

/** Maximum number of fingerprint versions to keep per account */
export const MAX_FINGERPRINT_HISTORY = 5;

export interface FingerprintHeaders {
  "User-Agent": string;
}

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function generateDeviceId(): string {
  return crypto.randomUUID();
}

function generateSessionToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Generate a randomized device fingerprint.
 * Each fingerprint represents a unique "device" identity.
 */
export function generateFingerprint(): Fingerprint {
  const platform = randomFrom(["darwin", "win32"] as const);
  const arch = randomFrom(ARCHITECTURES);
  const osVersion = randomFrom(OS_VERSIONS[platform] ?? OS_VERSIONS.darwin!);

  const matchingPlatform =
    platform === "win32"
      ? "WINDOWS"
      : "MACOS";

  return {
    deviceId: generateDeviceId(),
    sessionToken: generateSessionToken(),
    userAgent: `antigravity/${getAntigravityVersion()} ${platform}/${arch}`,
    apiClient: randomFrom(SDK_CLIENTS),
    clientMetadata: {
      ideType: randomFrom(IDE_TYPES),
      platform: matchingPlatform,
      pluginType: "GEMINI",
    },
    createdAt: Date.now(),
  };
}

/**
 * Collect fingerprint based on actual current system.
 * Uses real OS info instead of randomized values.
 */
export function collectCurrentFingerprint(): Fingerprint {
  const platform = os.platform();
  const arch = os.arch();

  const matchingPlatform =
    platform === "win32"
      ? "WINDOWS"
      : "MACOS";

  return {
    deviceId: generateDeviceId(),
    sessionToken: generateSessionToken(),
    userAgent: `antigravity/${getAntigravityVersion()} ${platform}/${arch}`,
    apiClient: "google-cloud-sdk vscode_cloudshelleditor/0.1",
    clientMetadata: {
      ideType: "ANTIGRAVITY",
      platform: matchingPlatform,
      pluginType: "GEMINI",
    },
    createdAt: Date.now(),
  };
}

/**
 * Build HTTP headers from a fingerprint object.
 * These headers are used to identify the "device" making API requests.
 */
export function buildFingerprintHeaders(fingerprint: Fingerprint | null): Partial<FingerprintHeaders> {
  if (!fingerprint) {
    return {};
  }

  return {
    "User-Agent": fingerprint.userAgent,
  };
}

/**
 * Session-level fingerprint instance.
 * Generated once at module load, persists for the lifetime of the process.
 */
let sessionFingerprint: Fingerprint | null = null;

/**
 * Get or create the session fingerprint.
 * Returns the same fingerprint for all calls within a session.
 */
export function getSessionFingerprint(): Fingerprint {
  if (!sessionFingerprint) {
    sessionFingerprint = generateFingerprint();
  }
  return sessionFingerprint;
}

/**
 * Regenerate the session fingerprint.
 * Call this to get a fresh identity (e.g., after rate limiting).
 */
export function regenerateSessionFingerprint(): Fingerprint {
  sessionFingerprint = generateFingerprint();
  return sessionFingerprint;
}

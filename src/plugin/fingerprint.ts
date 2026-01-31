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
import { ANTIGRAVITY_VERSION } from "../constants";

const OS_VERSIONS: Record<string, string[]> = {
  darwin: ["10.15.7", "11.6.8", "12.6.3", "13.5.2", "14.2.1", "14.5"],
  win32: ["10.0.19041", "10.0.19042", "10.0.19043", "10.0.22000", "10.0.22621", "10.0.22631"],
  linux: ["5.15.0", "5.19.0", "6.1.0", "6.2.0", "6.5.0", "6.6.0"],
};

const ARCHITECTURES = ["x64", "arm64"];

const IDE_TYPES = [
  "IDE_UNSPECIFIED",
  "VSCODE",
  "INTELLIJ",
  "ANDROID_STUDIO",
  "CLOUD_SHELL_EDITOR",
];

const PLATFORMS = [
  "PLATFORM_UNSPECIFIED",
  "WINDOWS",
  "MACOS",
  "LINUX",
];

const SDK_CLIENTS = [
  "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "google-cloud-sdk vscode/1.86.0",
  "google-cloud-sdk vscode/1.87.0",
  "google-cloud-sdk intellij/2024.1",
  "google-cloud-sdk android-studio/2024.1",
  "gcloud-python/1.2.0 grpc-google-iam-v1/0.12.6",
];

export interface ClientMetadata {
  ideType: string;
  platform: string;
  pluginType: string;
  osVersion: string;
  arch: string;
  sqmId?: string;
}

export interface Fingerprint {
  deviceId: string;
  sessionToken: string;
  userAgent: string;
  apiClient: string;
  clientMetadata: ClientMetadata;
  quotaUser: string;
  createdAt: number;
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
  "X-Goog-Api-Client": string;
  "Client-Metadata": string;
  "X-Goog-QuotaUser": string;
  "X-Client-Device-Id": string;
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
  const platform = randomFrom(["darwin", "win32", "linux"]);
  const arch = randomFrom(ARCHITECTURES);
  const osVersion = randomFrom(OS_VERSIONS[platform] ?? OS_VERSIONS.linux!);

  const matchingPlatform =
    platform === "darwin"
      ? "MACOS"
      : platform === "win32"
        ? "WINDOWS"
        : platform === "linux"
          ? "LINUX"
          : randomFrom(PLATFORMS);

  return {
    deviceId: generateDeviceId(),
    sessionToken: generateSessionToken(),
    userAgent: `antigravity/${ANTIGRAVITY_VERSION} ${platform}/${arch}`,
    apiClient: randomFrom(SDK_CLIENTS),
    clientMetadata: {
      ideType: randomFrom(IDE_TYPES),
      platform: matchingPlatform,
      pluginType: "GEMINI",
      osVersion: osVersion,
      arch: arch,
      sqmId: `{${crypto.randomUUID().toUpperCase()}}`,
    },
    quotaUser: `device-${crypto.randomBytes(8).toString("hex")}`,
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
  const osRelease = os.release();

  const matchingPlatform =
    platform === "darwin"
      ? "MACOS"
      : platform === "win32"
        ? "WINDOWS"
        : platform === "linux"
          ? "LINUX"
          : "PLATFORM_UNSPECIFIED";

  return {
    deviceId: generateDeviceId(),
    sessionToken: generateSessionToken(),
    userAgent: `antigravity/${ANTIGRAVITY_VERSION} ${platform}/${arch}`,
    apiClient: "google-cloud-sdk vscode_cloudshelleditor/0.1",
    clientMetadata: {
      ideType: "VSCODE",
      platform: matchingPlatform,
      pluginType: "GEMINI",
      osVersion: osRelease,
      arch: arch,
      sqmId: `{${crypto.randomUUID().toUpperCase()}}`, // Session-specific for current device
    },
    quotaUser: `device-${crypto.createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16)}`,
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
    "X-Goog-Api-Client": fingerprint.apiClient,
    "Client-Metadata": JSON.stringify(fingerprint.clientMetadata),
    "X-Goog-QuotaUser": fingerprint.quotaUser,
    "X-Client-Device-Id": fingerprint.deviceId,
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

/**
 * Cross-process account reservation system to prevent race conditions
 * when multiple OpenCode processes (subagents) use the same account.
 *
 * File: ~/.config/opencode/antigravity-reservations.json
 * TTL: 30s | Cache: 2s | Jitter: 0-300ms
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { getReservationPath } from "./storage";
import type { ModelFamily } from "./storage";

const RESERVATION_TTL_MS = 30_000;
const CACHE_TTL_MS = 2_000;
const JITTER_MAX_MS = 300;

export interface Reservation {
  pid: number;
  timestamp: number;
  family: ModelFamily;
  expiresAt: number;
}

export interface ReservationFile {
  reservations: Record<string, Reservation>;
}

let cachedReservations: ReservationFile | null = null;
let lastReadTime = 0;
const myReservations = new Set<number>();

function nowMs(): number {
  return Date.now();
}

export const internal = {
  isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
};

async function readReservations(): Promise<ReservationFile> {
  const now = nowMs();

  if (cachedReservations && now - lastReadTime < CACHE_TTL_MS) {
    return cachedReservations;
  }

  try {
    const path = getReservationPath();
    const content = await fs.readFile(path, "utf-8");
    cachedReservations = JSON.parse(content) as ReservationFile;
    lastReadTime = now;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") {
      cachedReservations = { reservations: {} };
    } else {
      cachedReservations = { reservations: {} };
    }
    lastReadTime = now;
  }

  return cachedReservations;
}

async function writeReservations(data: ReservationFile): Promise<void> {
  const path = getReservationPath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(data, null, 2), "utf-8");
  cachedReservations = data;
  lastReadTime = nowMs();
}

function cleanStaleReservations(data: ReservationFile): ReservationFile {
  const now = nowMs();
  const cleaned: Record<string, Reservation> = {};

  for (const [key, res] of Object.entries(data.reservations)) {
    const isExpired = now >= res.expiresAt;
    const isOurs = res.pid === process.pid;
    const isAlive = internal.isPidAlive(res.pid);

    if (!isExpired && (isOurs || isAlive)) {
      cleaned[key] = res;
    }
  }

  return { reservations: cleaned };
}

export async function isAccountReserved(
  accountIndex: number,
  family: ModelFamily,
): Promise<boolean> {
  const data = await readReservations();
  const key = String(accountIndex);
  const res = data.reservations[key];

  if (!res) return false;

  const now = nowMs();
  if (now >= res.expiresAt) return false;
  if (res.pid === process.pid) return false;
  if (!internal.isPidAlive(res.pid)) return false;
  if (res.family !== family) return false;

  return true;
}

export async function reserveAccount(
  accountIndex: number,
  family: ModelFamily,
): Promise<void> {
  const data = await readReservations();
  const cleaned = cleanStaleReservations(data);
  const now = nowMs();

  cleaned.reservations[String(accountIndex)] = {
    pid: process.pid,
    timestamp: now,
    family,
    expiresAt: now + RESERVATION_TTL_MS,
  };

  myReservations.add(accountIndex);
  await writeReservations(cleaned);
}

export async function refreshReservation(
  accountIndex: number,
  family: ModelFamily,
): Promise<void> {
  const data = await readReservations();
  const key = String(accountIndex);
  const existing = data.reservations[key];

  if (existing && existing.pid === process.pid) {
    const now = nowMs();
    existing.expiresAt = now + RESERVATION_TTL_MS;
    existing.timestamp = now;
    await writeReservations(data);
  } else {
    await reserveAccount(accountIndex, family);
  }
}

export async function releaseAccount(accountIndex: number): Promise<void> {
  myReservations.delete(accountIndex);

  try {
    const data = await readReservations();
    const key = String(accountIndex);

    if (data.reservations[key]?.pid === process.pid) {
      delete data.reservations[key];
      await writeReservations(data);
    }
  } catch {
    // Best effort
  }
}

export async function releaseAllReservations(): Promise<void> {
  if (myReservations.size === 0) return;

  try {
    const data = await readReservations();
    let changed = false;

    for (const key of Object.keys(data.reservations)) {
      if (data.reservations[key]?.pid === process.pid) {
        delete data.reservations[key];
        changed = true;
      }
    }

    if (changed) {
      await writeReservations(data);
    }
  } catch {
    // Best effort
  }

  myReservations.clear();
}

export function releaseAllReservationsSync(): void {
  if (myReservations.size === 0) return;

  try {
    const path = getReservationPath();
    const { readFileSync, writeFileSync } = require("node:fs") as typeof import("node:fs");

    const content = readFileSync(path, "utf-8");
    const data = JSON.parse(content) as ReservationFile;
    let changed = false;

    for (const key of Object.keys(data.reservations)) {
      if (data.reservations[key]?.pid === process.pid) {
        delete data.reservations[key];
        changed = true;
      }
    }

    if (changed) {
      writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
    }
  } catch {
    // Best effort
  }

  myReservations.clear();
}

export async function applyStartupJitter(): Promise<void> {
  const jitter = Math.floor(Math.random() * JITTER_MAX_MS);
  if (jitter > 0) {
    await new Promise((resolve) => setTimeout(resolve, jitter));
  }
}

export async function getAvailableAccountIndices(
  totalAccounts: number,
  family: ModelFamily,
): Promise<number[]> {
  const available: number[] = [];

  for (let i = 0; i < totalAccounts; i++) {
    if (!(await isAccountReserved(i, family))) {
      available.push(i);
    }
  }

  return available;
}

export function hasOwnReservation(accountIndex: number): boolean {
  return myReservations.has(accountIndex);
}

export function getOwnReservations(): number[] {
  return Array.from(myReservations);
}

export function invalidateCache(): void {
  cachedReservations = null;
  lastReadTime = 0;
}

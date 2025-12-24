import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isAccountReserved,
  reserveAccount,
  releaseAccount,
  releaseAllReservations,
  getAvailableAccountIndices,
  hasOwnReservation,
  getOwnReservations,
  invalidateCache,
  internal,
} from "./reservation";
import * as storage from "./storage";

describe("Reservation System", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "reservation-test-"));
    vi.spyOn(storage, "getReservationPath").mockReturnValue(
      join(tempDir, "antigravity-reservations.json")
    );
    invalidateCache();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await releaseAllReservations();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("reserveAccount", () => {
    it("creates reservation file if not exists", async () => {
      await reserveAccount(0, "gemini");

      const path = storage.getReservationPath();
      const content = await fs.readFile(path, "utf-8");
      const data = JSON.parse(content);

      expect(data.reservations["0"]).toBeDefined();
      expect(data.reservations["0"].pid).toBe(process.pid);
      expect(data.reservations["0"].family).toBe("gemini");
    });

    it("tracks reservation in memory", async () => {
      await reserveAccount(1, "claude");

      expect(hasOwnReservation(1)).toBe(true);
      expect(getOwnReservations()).toContain(1);
    });
  });

  describe("isAccountReserved", () => {
    it("returns false for unreserved account", async () => {
      const reserved = await isAccountReserved(0, "gemini");
      expect(reserved).toBe(false);
    });

    it("returns false for own reservation", async () => {
      await reserveAccount(0, "gemini");
      const reserved = await isAccountReserved(0, "gemini");
      expect(reserved).toBe(false);
    });

    it("returns false for different family", async () => {
      await reserveAccount(0, "gemini");
      const reserved = await isAccountReserved(0, "claude");
      expect(reserved).toBe(false);
    });

    it("returns true for reservation by another process", async () => {
      vi.spyOn(internal, "isPidAlive").mockReturnValue(true);

      const path = storage.getReservationPath();
      const fakeReservation = {
        reservations: {
          "0": {
            pid: 99999999,
            timestamp: Date.now(),
            family: "gemini",
            expiresAt: Date.now() + 30000,
          },
        },
      };
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(path, JSON.stringify(fakeReservation));
      invalidateCache();

      const reserved = await isAccountReserved(0, "gemini");
      expect(reserved).toBe(true);
    });

    it("returns false for expired reservation", async () => {
      const path = storage.getReservationPath();
      const expiredReservation = {
        reservations: {
          "0": {
            pid: 99999999,
            timestamp: Date.now() - 60000,
            family: "gemini",
            expiresAt: Date.now() - 30000,
          },
        },
      };
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(path, JSON.stringify(expiredReservation));
      invalidateCache();

      const reserved = await isAccountReserved(0, "gemini");
      expect(reserved).toBe(false);
    });
  });

  describe("releaseAccount", () => {
    it("removes reservation from file", async () => {
      await reserveAccount(0, "gemini");
      await releaseAccount(0);

      const path = storage.getReservationPath();
      const content = await fs.readFile(path, "utf-8");
      const data = JSON.parse(content);

      expect(data.reservations["0"]).toBeUndefined();
    });

    it("removes from memory tracking", async () => {
      await reserveAccount(0, "gemini");
      expect(hasOwnReservation(0)).toBe(true);

      await releaseAccount(0);
      expect(hasOwnReservation(0)).toBe(false);
    });
  });

  describe("releaseAllReservations", () => {
    it("releases all reservations made by this process", async () => {
      await reserveAccount(0, "gemini");
      await reserveAccount(1, "claude");
      await reserveAccount(2, "gemini");

      expect(getOwnReservations().length).toBe(3);

      await releaseAllReservations();

      expect(getOwnReservations().length).toBe(0);
    });
  });

  describe("getAvailableAccountIndices", () => {
    it("returns all accounts when none reserved", async () => {
      const available = await getAvailableAccountIndices(3, "gemini");
      expect(available).toEqual([0, 1, 2]);
    });

    it("excludes accounts reserved by other processes", async () => {
      vi.spyOn(internal, "isPidAlive").mockReturnValue(true);

      const path = storage.getReservationPath();
      const fakeReservation = {
        reservations: {
          "1": {
            pid: 99999999,
            timestamp: Date.now(),
            family: "gemini",
            expiresAt: Date.now() + 30000,
          },
        },
      };
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(path, JSON.stringify(fakeReservation));
      invalidateCache();

      const available = await getAvailableAccountIndices(3, "gemini");
      expect(available).toEqual([0, 2]);
    });

    it("includes own reservations", async () => {
      await reserveAccount(1, "gemini");
      const available = await getAvailableAccountIndices(3, "gemini");
      expect(available).toEqual([0, 1, 2]);
    });
  });
});

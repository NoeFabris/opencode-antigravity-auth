import { afterEach, describe, expect, it, vi } from "vitest";

import { showAccountRouting } from "./cli";

describe("showAccountRouting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses live quota model data before cached account quota", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    showAccountRouting(
      [{
        index: 0,
        email: "user@example.com",
        cachedQuota: {
          "gemini-pro": { remainingFraction: 0.1, modelCount: 1 },
        },
      }],
      {
        strict: true,
        entries: [{
          model: "antigravity-gemini-3.1-pro",
          normalizedModel: "antigravity-gemini-3.1-pro",
          email: "user@example.com",
          quotaModels: [{
            modelId: "gemini-3.1-pro-high",
            displayName: "Gemini 3.1 Pro (High)",
            group: "gemini-pro",
            remainingFraction: 0.8,
          }],
        }],
      },
    );

    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Quota:      80% remaining");
    expect(output).not.toContain("Quota:      10% remaining");
  });

  it("summarizes live quota with the lowest remaining model in the group", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    showAccountRouting(
      [{ index: 0, email: "user@example.com" }],
      {
        strict: true,
        entries: [{
          model: "antigravity-gemini-3.1-pro",
          normalizedModel: "antigravity-gemini-3.1-pro",
          email: "user@example.com",
          quotaModels: [{
            modelId: "gemini-3.1-pro-low",
            group: "gemini-pro",
            remainingFraction: 0.7,
          }, {
            modelId: "gemini-3.1-pro-high",
            group: "gemini-pro",
            remainingFraction: 0.2,
          }],
        }],
      },
    );

    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Quota:      20% remaining");
    expect(output).not.toContain("Quota:      70% remaining");
  });
});

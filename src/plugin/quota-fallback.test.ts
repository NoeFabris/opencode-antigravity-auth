import { beforeAll, describe, expect, it, vi } from "vitest";
import type { HeaderStyle, ModelFamily } from "./accounts";

type ResolveQuotaFallbackHeaderStyle = (input: {
  quotaFallback: boolean;
  cliFirst: boolean;
  explicitQuota: boolean;
  family: ModelFamily;
  headerStyle: HeaderStyle;
  alternateStyle: HeaderStyle | null;
}) => HeaderStyle | null;

type GetHeaderStyleFromUrl = (
  urlString: string,
  family: ModelFamily,
  cliFirst?: boolean,
) => HeaderStyle;

let resolveQuotaFallbackHeaderStyle: ResolveQuotaFallbackHeaderStyle | undefined;
let getHeaderStyleFromUrl: GetHeaderStyleFromUrl | undefined;

beforeAll(async () => {
  vi.mock("@opencode-ai/plugin", () => ({
    tool: vi.fn(),
  }));

  const { __testExports } = await import("../plugin");
  resolveQuotaFallbackHeaderStyle = (__testExports as {
    resolveQuotaFallbackHeaderStyle?: ResolveQuotaFallbackHeaderStyle;
  }).resolveQuotaFallbackHeaderStyle;
  getHeaderStyleFromUrl = (__testExports as {
    getHeaderStyleFromUrl?: GetHeaderStyleFromUrl;
  }).getHeaderStyleFromUrl;
});

describe("quota fallback direction", () => {
  it("falls back from gemini-cli to antigravity when cli_first is enabled", () => {
    const result = resolveQuotaFallbackHeaderStyle?.({
      quotaFallback: true,
      cliFirst: true,
      explicitQuota: false,
      family: "gemini",
      headerStyle: "gemini-cli",
      alternateStyle: "antigravity",
    });

    expect(result).toBe("antigravity");
  });

  it("does not fall back from antigravity when cli_first is enabled", () => {
    const result = resolveQuotaFallbackHeaderStyle?.({
      quotaFallback: true,
      cliFirst: true,
      explicitQuota: false,
      family: "gemini",
      headerStyle: "antigravity",
      alternateStyle: "gemini-cli",
    });

    expect(result).toBeNull();
  });

  it("falls back from antigravity to gemini-cli when cli_first is disabled", () => {
    const result = resolveQuotaFallbackHeaderStyle?.({
      quotaFallback: true,
      cliFirst: false,
      explicitQuota: false,
      family: "gemini",
      headerStyle: "antigravity",
      alternateStyle: "gemini-cli",
    });

    expect(result).toBe("gemini-cli");
  });
});

describe("header style resolution", () => {
  it("uses gemini-cli for unsuffixed Gemini models when cli_first is enabled", () => {
    const headerStyle = getHeaderStyleFromUrl?.(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent",
      "gemini",
      true,
    );

    expect(headerStyle).toBe("gemini-cli");
  });

  it("keeps antigravity for unsuffixed Gemini models when cli_first is disabled", () => {
    const headerStyle = getHeaderStyleFromUrl?.(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent",
      "gemini",
      false,
    );

    expect(headerStyle).toBe("antigravity");
  });

  it("keeps antigravity for explicit antigravity prefix when cli_first is enabled", () => {
    const headerStyle = getHeaderStyleFromUrl?.(
      "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3-flash:streamGenerateContent",
      "gemini",
      true,
    );

    expect(headerStyle).toBe("antigravity");
  });

  it("keeps antigravity for Claude when cli_first is enabled", () => {
    const headerStyle = getHeaderStyleFromUrl?.(
      "https://generativelanguage.googleapis.com/v1beta/models/claude-sonnet-4-5-thinking:streamGenerateContent",
      "claude",
      true,
    );

    expect(headerStyle).toBe("antigravity");
  });
});

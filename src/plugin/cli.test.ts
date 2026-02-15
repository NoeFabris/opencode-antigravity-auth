import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = { answers: [] as string[] };
  const question = vi.fn(async () => state.answers.shift() ?? "");
  const close = vi.fn();
  const createInterface = vi.fn(() => ({ question, close }));

  const showAuthMenu = vi.fn();
  const showAccountDetails = vi.fn();
  const isTTY = vi.fn(() => true);
  const updateOpencodeConfig = vi.fn(async () => ({ success: true, configPath: "opencode.json" }));

  return {
    state,
    question,
    close,
    createInterface,
    showAuthMenu,
    showAccountDetails,
    isTTY,
    updateOpencodeConfig,
  };
});

vi.mock("node:readline/promises", () => ({
  createInterface: mocks.createInterface,
}));

vi.mock("./ui/auth-menu", () => ({
  showAuthMenu: mocks.showAuthMenu,
  showAccountDetails: mocks.showAccountDetails,
  isTTY: mocks.isTTY,
}));

vi.mock("./config/updater", () => ({
  updateOpencodeConfig: mocks.updateOpencodeConfig,
}));

import {
  promptAccountProxyConfiguration,
  promptLoginMode,
  promptOAuthProxyConfiguration,
} from "./cli";

describe("cli proxy behavior", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mocks.state.answers = [];
    mocks.question.mockClear();
    mocks.close.mockClear();
    mocks.createInterface.mockClear();
    mocks.showAuthMenu.mockReset();
    mocks.showAccountDetails.mockReset();
    mocks.isTTY.mockReset();
    mocks.isTTY.mockReturnValue(true);
    mocks.updateOpencodeConfig.mockReset();
    mocks.updateOpencodeConfig.mockResolvedValue({ success: true, configPath: "opencode.json" });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("reuses existing oauth proxies by default and returns a copy", async () => {
    const existing = [{ url: "http://127.0.0.1:8080/" }];
    mocks.state.answers = [""];

    const result = await promptOAuthProxyConfiguration(existing);

    expect(result).toEqual(existing);
    expect(result).not.toBe(existing);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("lets oauth proxy manager add and merge proxy entries", async () => {
    mocks.state.answers = [
      "y",
      "a",
      "http://127.0.0.1:8080",
      "a",
      "!http://127.0.0.1:8080,socks5://127.0.0.1:1080",
      "s",
    ];

    const result = await promptOAuthProxyConfiguration([]);

    expect(result).toEqual([
      { url: "http://127.0.0.1:8080/", enabled: false },
      { url: "socks5://127.0.0.1:1080" },
    ]);
  });

  it("re-prompts oauth proxy add when input is invalid", async () => {
    mocks.state.answers = [
      "y",
      "a",
      "ftp://bad",
      "a",
      "http://127.0.0.1:8080",
      "s",
    ];

    const result = await promptOAuthProxyConfiguration([]);

    expect(result).toEqual([{ url: "http://127.0.0.1:8080/" }]);
  });

  it("returns empty proxy list when oauth proxy setup is declined", async () => {
    mocks.state.answers = ["n"];

    const result = await promptOAuthProxyConfiguration([]);

    expect(result).toEqual([]);
  });

  it("keeps account proxy config unchanged when user cancels", async () => {
    mocks.state.answers = ["x"];

    const result = await promptAccountProxyConfiguration("Account 1", [{ url: "http://127.0.0.1:8080/" }]);

    expect(result).toBeUndefined();
  });

  it("deletes a single selected proxy from account manager", async () => {
    mocks.state.answers = ["d", "1", "s"];

    const result = await promptAccountProxyConfiguration("Account 1", [
      { url: "http://127.0.0.1:8080/" },
      { url: "socks5://127.0.0.1:1080" },
    ]);

    expect(result).toEqual([{ url: "socks5://127.0.0.1:1080" }]);
  });

  it("toggles a single selected proxy in account manager", async () => {
    mocks.state.answers = ["t", "1", "s"];

    const result = await promptAccountProxyConfiguration("Account 2", [{ url: "http://127.0.0.1:8080/" }]);

    expect(result).toEqual([{ url: "http://127.0.0.1:8080/", enabled: false }]);
  });

  it("returns configureProxyAccountIndex when account proxy action is selected", async () => {
    const account = { index: 3, email: "a@example.com" };
    mocks.showAuthMenu.mockResolvedValue({ type: "select-account", account });
    mocks.showAccountDetails.mockResolvedValue("proxy");

    const result = await promptLoginMode([account]);

    expect(result).toEqual({ mode: "manage", configureProxyAccountIndex: 3 });
  });

  it("supports proxy management selection in non-tty fallback", async () => {
    mocks.isTTY.mockReturnValue(false);
    mocks.state.answers = ["p", "2"];

    const result = await promptLoginMode([
      { index: 0, email: "first@example.com" },
      { index: 1, email: "second@example.com" },
    ]);

    expect(result).toEqual({ mode: "manage", configureProxyAccountIndex: 1 });
  });
});


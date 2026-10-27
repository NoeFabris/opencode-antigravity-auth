import { afterEach, describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin/tui"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import type { AccountSummary } from "./plugin/account-rpc.ts"
import { AntigravityTuiPlugin } from "./tui.ts"

const account: AccountSummary = { id: "account-id", email: "saved@example.test", enabled: true, current: true, verificationRequired: false, lastUsed: 1 }

afterEach(() => vi.useRealTimers())

async function host(actions: Array<string | undefined>, options: { confirmed?: boolean; accounts?: AccountSummary[] } = {}) {
  let layer: KeymapLayer | undefined
  const rpc = {
    list: vi.fn(async () => options.accounts ?? [account]), connections: vi.fn(async () => ({ ids: ["native-credential"] })), quotas: vi.fn(async () => ({ report: "Antigravity claude: 84% remaining; resets tomorrow", accounts: [{ id: account.id, email: account.email, disabled: false, report: "Antigravity claude: 84% remaining; resets tomorrow" }] })),
    update: vi.fn(async () => ({ message: "Account updated" })), models: vi.fn(async () => ({ count: 12 })),
  }
  const select = vi.fn(async (_options: { title: string; options: Array<{ title: string; value: string }> }) => actions.shift())
  const alert = vi.fn(async () => undefined)
  const remove = vi.fn(async () => undefined)
  const cancel = vi.fn(async () => undefined)
  const toast = vi.fn()
  const ctx = {
    client: { rpc: () => rpc, credential: { remove }, integration: { oauth: {
      connect: vi.fn(async () => ({ data: { attemptID: "attempt", url: "https://accounts.google.com", instructions: "Sign in" } })),
      complete: vi.fn(async () => undefined), cancel,
    } } },
    location: { directory: "/tmp/menu-test" },
    ui: { dialog: { select, alert, confirm: async () => options.confirmed ?? false, prompt: async () => undefined }, toast: { show: toast } },
    keymap: { layer: (factory: () => KeymapLayer) => { layer = factory() } },
  } as unknown as Plugin.Context
  await AntigravityTuiPlugin.setup(ctx)
  const command = layer?.commands?.[0]
  if (!command) throw new Error("Account menu command was not registered")
  await command.run()
  return { command, rpc, select, alert, remove, cancel, toast }
}

describe("Antigravity native menu", () => {
  it("opens from /antigravity, lists saved accounts, and displays quotas", async () => {
    const result = await host(["quotas", undefined])
    expect(result.command.slash).toEqual({ name: "antigravity", aliases: ["ag"] })
    expect(result.select.mock.calls[0]?.[0].options).toContainEqual(expect.objectContaining({ title: "saved@example.test [current]" }))
    expect(result.rpc.list).toHaveBeenCalledTimes(2)
    expect(result.rpc.quotas).toHaveBeenCalledOnce()
    expect(result.alert).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("84% remaining") }))
  })

  it("requires confirmation before deleting an account or its native connection", async () => {
    const cancelled = await host(["manage", "account-id", "delete", undefined])
    expect(cancelled.remove).not.toHaveBeenCalled()
    expect(cancelled.rpc.update).not.toHaveBeenCalled()
    const confirmed = await host(["manage", "account-id", "delete", undefined], { confirmed: true })
    expect(confirmed.remove).toHaveBeenCalledWith({ credentialID: "native-credential" })
    expect(confirmed.rpc.update).toHaveBeenCalledWith({ id: "account-id", action: "delete" }, expect.any(Object))
    expect(confirmed.remove.mock.invocationCallOrder[0]).toBeLessThan(confirmed.rpc.update.mock.invocationCallOrder[0]!)
  })

  it("cancels the OAuth attempt when the account dialog is dismissed", async () => {
    const result = await host(["add", undefined])
    expect(result.cancel).toHaveBeenCalledWith(expect.objectContaining({ attemptID: "attempt" }))
  })

  it("shows cached quota in account rows without fetching quotas or native connections", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"))
    const result = await host([undefined], { accounts: [
      { ...account, quota: { remainingFraction: 0.81, resetTime: "2026-10-27T14:54:00Z" } },
      { ...account, id: "disabled-id", email: "disabled@example.test", current: false, enabled: false, verificationRequired: true },
    ] })
    expect(result.select.mock.calls[0]?.[0].options).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "saved@example.test [current]", description: "81% · resets in 2h 54m" }),
      expect.objectContaining({ title: "disabled@example.test [disabled] [needs verification]", description: "no quota data" }),
    ]))
    expect(result.rpc.quotas).not.toHaveBeenCalled()
    expect(result.rpc.connections).not.toHaveBeenCalled()
    expect(result.rpc.models).not.toHaveBeenCalled()
    expect(result.rpc.update).not.toHaveBeenCalled()
  })

  it("selects an enabled account directly and closes the menu", async () => {
    const result = await host(["account-id"], { accounts: [{ ...account, current: false }] })
    expect(result.select).toHaveBeenCalledOnce()
    expect(result.rpc.list).toHaveBeenCalledOnce()
    expect(result.rpc.update).toHaveBeenCalledWith({ id: "account-id", action: "select" }, { location: { directory: "/tmp/menu-test" } })
    expect(result.toast).toHaveBeenCalledWith({ message: "Account updated", variant: "success" })
    expect(result.rpc.quotas).not.toHaveBeenCalled()
  })

  it("opens management for a disabled account instead of switching to it", async () => {
    const result = await host(["account-id", undefined, undefined], { accounts: [{ ...account, enabled: false }] })
    expect(result.select.mock.calls[1]?.[0].options).toContainEqual({ title: "Use this account", value: "select", disabled: true })
    expect(result.rpc.update).not.toHaveBeenCalled()
  })

  it("keeps per-account quota verification available through management", async () => {
    const result = await host(["manage", "account-id", "verify", undefined])
    expect(result.rpc.quotas).toHaveBeenCalledWith({ id: "account-id" }, expect.any(Object))
    expect(result.rpc.update).not.toHaveBeenCalled()
  })

  it.each(["enable", "disable"] as const)("keeps the %s action available through management", async action => {
    const result = await host(["manage", "account-id", action, undefined], { accounts: [{ ...account, enabled: action === "disable" }] })
    expect(result.rpc.update).toHaveBeenCalledWith({ id: "account-id", action }, expect.any(Object))
  })

  it("keeps re-authentication available through management", async () => {
    const result = await host(["manage", "account-id", "login", undefined])
    expect(result.cancel).toHaveBeenCalledWith(expect.objectContaining({ attemptID: "attempt" }))
    expect(result.rpc.update).not.toHaveBeenCalled()
  })

  it("returns to the main menu when account management is dismissed", async () => {
    const result = await host(["manage", undefined, undefined])
    expect(result.rpc.list).toHaveBeenCalledTimes(2)
    expect(result.rpc.update).not.toHaveBeenCalled()
  })
})

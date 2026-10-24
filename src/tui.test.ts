import { describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin/tui"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import { AntigravityTuiPlugin, formatAccountQuota } from "./tui.ts"

async function host(actions: Array<string | undefined>, confirmed = false, overrides: Record<string, unknown> = {}) {
  let layer: KeymapLayer | undefined
  const account = { id: "account-id", email: "saved@example.test", enabled: true, current: true, verificationRequired: false, lastUsed: 1, connectionIDs: ["native-credential"], ...overrides }
  const rpc = {
    list: vi.fn(async () => [account]), connections: vi.fn(async () => ({ ids: ["native-credential"] })), quotas: vi.fn(async () => ({ report: "Antigravity claude: 84% remaining; resets tomorrow", accounts: [{ id: account.id, email: account.email, disabled: false, report: "Antigravity claude: 84% remaining; resets tomorrow" }] })),
    update: vi.fn(async () => ({ message: "Account updated" })), models: vi.fn(async () => ({ count: 12 })),
  }
  const select = vi.fn(async (_options: { title: string; options: Array<{ title: string; value: string }> }) => actions.shift())
  const alert = vi.fn(async () => undefined)
  const remove = vi.fn(async () => undefined)
  const cancel = vi.fn(async () => undefined)
  const ctx = {
    client: { rpc: () => rpc, credential: { remove }, integration: { oauth: {
      connect: vi.fn(async () => ({ data: { attemptID: "attempt", url: "https://accounts.google.com", instructions: "Sign in" } })),
      complete: vi.fn(async () => undefined), cancel,
    } } },
    location: { directory: "/tmp/menu-test" },
    ui: { dialog: { select, alert, confirm: async () => confirmed, prompt: async () => undefined }, toast: { show: vi.fn() } },
    keymap: { layer: (factory: () => KeymapLayer) => { layer = factory() } },
  } as unknown as Plugin.Context
  await AntigravityTuiPlugin.setup(ctx)
  const command = layer?.commands?.[0]
  if (!command) throw new Error("Account menu command was not registered")
  await command.run()
  return { command, rpc, select, alert, remove, cancel }
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
    const confirmed = await host(["manage", "account-id", "delete", undefined], true)
    expect(confirmed.remove).toHaveBeenCalledWith({ credentialID: "native-credential" })
    expect(confirmed.rpc.update).toHaveBeenCalledWith({ id: "account-id", action: "delete" }, expect.any(Object))
    expect(confirmed.remove.mock.invocationCallOrder[0]).toBeLessThan(confirmed.rpc.update.mock.invocationCallOrder[0]!)
  })

  it("cancels the OAuth attempt when the account dialog is dismissed", async () => {
    const result = await host(["add", undefined])
    expect(result.cancel).toHaveBeenCalledWith(expect.objectContaining({ attemptID: "attempt" }))
  })

  it("shows cached quota beside each account", async () => {
    const result = await host([undefined], false, { quota: { remainingFraction: 1 } })
    expect(result.select.mock.calls[0]?.[0].options).toContainEqual(expect.objectContaining({ value: "account-id", description: "100%" }))
    expect(result.rpc.quotas).not.toHaveBeenCalled()
  })

  it("switches to a picked account in one step and closes the menu", async () => {
    const result = await host(["account-id"], false, { current: false })
    expect(result.rpc.update).toHaveBeenCalledWith({ id: "account-id", action: "select" }, expect.any(Object))
    expect(result.select).toHaveBeenCalledOnce()
  })

  it("closes without switching when the current account is picked", async () => {
    const result = await host(["account-id"])
    expect(result.rpc.update).not.toHaveBeenCalled()
    expect(result.select).toHaveBeenCalledOnce()
  })
})

describe("formatAccountQuota", () => {
  const now = Date.parse("2026-10-24T00:00:00Z")

  it("shows the percentage and time until reset", () => {
    expect(formatAccountQuota({ remainingFraction: 0.814, resetTime: "2026-10-24T02:54:00Z" }, now)).toBe("81% · resets in 2h 54m")
    expect(formatAccountQuota({ remainingFraction: 0.79, resetTime: "2026-10-30T21:10:00Z" }, now)).toBe("79% · resets in 6d 21h")
    expect(formatAccountQuota({ remainingFraction: 0.5, resetTime: "2026-10-24T00:07:00Z" }, now)).toBe("50% · resets in 7m")
  })

  it("omits the reset for a full or undated quota and reports missing data", () => {
    expect(formatAccountQuota({ remainingFraction: 1, resetTime: "2026-10-30T21:10:00Z" }, now)).toBe("100%")
    expect(formatAccountQuota({ remainingFraction: 0.4 }, now)).toBe("40%")
    expect(formatAccountQuota(undefined, now)).toBe("no quota data")
  })
})

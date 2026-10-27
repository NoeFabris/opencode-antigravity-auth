import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin"
import type { RpcHandlers } from "@opencode/plugin/promise/rpc"
import { AccountSummary, AntigravityAccountsRpc } from "./account-rpc.ts"
import { accountID, registerAccountManagement } from "./account-management.ts"
import type { AccountMetadataV3, AccountStorageV4 } from "./storage.ts"
import type { PluginClient } from "./types.ts"
import { checkAccountsQuota } from "./quota.ts"

vi.mock("./quota.ts", () => ({ checkAccountsQuota: vi.fn() }))

const state = vi.hoisted(() => ({ storage: undefined as AccountStorageV4 | undefined, beforeUpdate: undefined as (() => void) | undefined }))
vi.mock("./storage.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./storage.ts")>(),
  loadAccounts: async () => structuredClone(state.storage),
  updateAccounts: async (update: (storage: AccountStorageV4) => void) => {
    state.beforeUpdate?.()
    if (!state.storage) return null
    const storage = structuredClone(state.storage)
    update(storage)
    state.storage = storage
    return storage
  },
  saveAccounts: async (value: AccountStorageV4) => { state.storage = structuredClone(value) },
  saveAccountsReplace: async (value: AccountStorageV4) => { state.storage = structuredClone(value) },
}))

beforeEach(() => {
  vi.clearAllMocks()
  state.beforeUpdate = undefined
  state.storage = {
    version: 4, activeIndex: 1, activeIndexByFamily: { claude: 1, gemini: 2 },
    accounts: ["first", "second", "third"].map(name => ({ email: `${name}@example.test`, refreshToken: `${name}-secret`, addedAt: 1, lastUsed: 2 })),
  }
})

async function host(rotate = false) {
  let handlers: RpcHandlers<typeof AntigravityAccountsRpc> | undefined
  const beforeWrite = vi.fn(async () => undefined)
  const ctx = {
    rpc: { register: async (_definition: unknown, value: RpcHandlers<typeof AntigravityAccountsRpc>) => {
      handlers = value
      return { dispose: async () => undefined, events: { emit: async () => undefined } }
    } },
    integration: {
      get: vi.fn(async () => ({ data: { connections: [{ type: "credential", id: "native-first", method: "oauth" }] } })),
      connection: { active: async () => undefined, resolve: vi.fn(async () => {
        if (rotate) state.storage!.accounts[0]!.refreshToken = "rotated-secret"
        return { type: "oauth", refresh: `${rotate ? "rotated-secret" : "first-secret"}|project` }
      }) },
    },
    storage: { get: vi.fn(async () => undefined), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
    credential: { activate: vi.fn(async () => undefined) },
  } as unknown as Plugin.Context
  await registerAccountManagement(ctx, {} as PluginClient, beforeWrite, async () => 7)
  if (!handlers) throw new Error("Account RPC was not registered")
  return { handlers, beforeWrite, ctx }
}

const callContext = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }

describe("account management", () => {
  it("lists all accounts and associated native credentials without exposing OAuth tokens", async () => {
    const { handlers } = await host()
    const accounts = await handlers.list({}, callContext)
    expect(accounts).toHaveLength(3)
    expect(await handlers.connections({ id: accounts[0]!.id }, callContext)).toEqual({ ids: ["native-first"] })
    expect(accounts[1]?.current).toBe(true)
    expect(JSON.stringify(accounts)).not.toContain("secret")
  })

  it("lists the lowest cached quota with that group's reset time without making live requests", async () => {
    const cachedQuota = {
      claude: { remainingFraction: 0.81, resetTime: "2026-10-27T13:00:00Z", remainingFractionResetTime: "2026-10-27T14:54:00Z", modelCount: 2 },
      "gemini-pro": { remainingFraction: 0.95, resetTime: "2026-10-27T13:00:00Z", modelCount: 1 },
      "gemini-flash": { remainingFraction: 1, modelCount: 1 },
    }
    state.storage!.accounts[0]!.cachedQuota = cachedQuota
    state.storage!.accounts[0]!.cachedQuotaUpdatedAt = 123
    const { handlers, ctx, beforeWrite } = await host()
    const accounts = await handlers.list({}, callContext)
    expect(AccountSummary.parse(accounts[0]).quota).toEqual({ remainingFraction: 0.81, resetTime: "2026-10-27T14:54:00Z", updatedAt: 123 })
    expect(accounts[1]?.quota).toBeUndefined()
    expect(state.storage!.accounts[0]!.cachedQuota).toEqual(cachedQuota)
    expect(checkAccountsQuota).not.toHaveBeenCalled()
    expect(ctx.integration.get).not.toHaveBeenCalled()
    expect(ctx.integration.connection.resolve).not.toHaveBeenCalled()
    expect(beforeWrite).not.toHaveBeenCalled()
    expect(JSON.stringify(accounts)).not.toContain("secret")
  })

  it("keeps an exhausted group's quota and ignores unknown fractions", async () => {
    state.storage!.accounts[0]!.cachedQuota = {
      claude: { modelCount: 1 },
      "gemini-pro": { remainingFraction: 1, modelCount: 1 },
      "gemini-flash": { remainingFraction: 0, resetTime: "2026-11-03T09:00:00Z", modelCount: 1 },
    }
    const { handlers } = await host()
    const accounts = await handlers.list({}, callContext)
    expect(AccountSummary.parse(accounts[0]).quota).toEqual({ remainingFraction: 0, resetTime: "2026-11-03T09:00:00Z" })
  })

  it("skips malformed saved groups and still lists valid quota data and other accounts", async () => {
    state.storage!.accounts[0]!.cachedQuota = JSON.parse('{"claude":null,"invalid":7,"text":"bad","flag":false,"array":[],"gemini-pro":{"remainingFraction":0.4,"modelCount":1}}')
    const { handlers } = await host()
    const accounts = await handlers.list({}, callContext)
    expect(accounts).toHaveLength(3)
    expect(AccountSummary.parse(accounts[0]).quota).toEqual({ remainingFraction: 0.4 })
    expect(accounts[1]?.quota).toBeUndefined()
  })

  it("omits ambiguous reset times from older multi-model caches", async () => {
    state.storage!.accounts[0]!.cachedQuota = {
      claude: { remainingFraction: 0.2, resetTime: "2026-10-27T13:00:00Z", modelCount: 2 },
    }
    const { handlers } = await host()
    const accounts = await handlers.list({}, callContext)
    expect(AccountSummary.parse(accounts[0]).quota).toEqual({ remainingFraction: 0.2 })
  })

  it("persists the minimum quota's reset from a quota check for subsequent list calls", async () => {
    const groups = {
      claude: { remainingFraction: 0.2, resetTime: "2026-10-27T13:00:00Z", remainingFractionResetTime: "2026-10-27T17:00:00Z", modelCount: 2 },
    }
    vi.mocked(checkAccountsQuota).mockResolvedValueOnce([{ index: 0, status: "ok", quota: { groups, modelCount: 2 } }])
    const { handlers } = await host()
    const [account] = await handlers.list({}, callContext)
    await handlers.quotas({ id: account!.id }, callContext)
    expect(state.storage?.accounts[0]?.cachedQuota).toEqual(groups)
    const accounts = await handlers.list({}, callContext)
    expect(AccountSummary.parse(accounts[0]).quota).toMatchObject({ remainingFraction: 0.2, resetTime: "2026-10-27T17:00:00Z" })
  })

  const missingQuotaCases: Array<{ name: string; cachedQuota: AccountMetadataV3["cachedQuota"] }> = [
    { name: "absent", cachedQuota: undefined },
    { name: "empty", cachedQuota: {} },
    { name: "unknown", cachedQuota: { claude: { modelCount: 1, resetTime: "2026-10-27T14:54:00Z" } } },
    { name: "invalid", cachedQuota: {
      claude: { remainingFraction: NaN, modelCount: 1 },
      "gemini-pro": { remainingFraction: -0.1, modelCount: 1 },
      "gemini-flash": { remainingFraction: 1.1, modelCount: 1 },
    } },
  ]
  it.each(missingQuotaCases)("omits the quota summary when cached data is $name", async ({ cachedQuota }) => {
    state.storage!.accounts[0]!.cachedQuota = cachedQuota
    const { handlers } = await host()
    const accounts = await handlers.list({}, callContext)
    expect(accounts[0]?.quota).toBeUndefined()
  })

  it("flushes the manager before disabling an account and moves selection to an enabled account", async () => {
    const { handlers, beforeWrite } = await host()
    const id = accountID(state.storage!.accounts[1]!)
    await handlers.update({ id, action: "disable" }, callContext)
    expect(beforeWrite).toHaveBeenCalledOnce()
    expect(state.storage?.accounts[1]?.enabled).toBe(false)
    expect(state.storage?.activeIndex).toBe(0)
    await expect(handlers.update({ id, action: "select" }, callContext)).rejects.toThrow("Enable this account")
  })

  it("deletes by stable account identity and keeps family cursors on their original accounts", async () => {
    const { handlers } = await host()
    await handlers.update({ id: accountID(state.storage!.accounts[0]!), action: "delete" }, callContext)
    expect(state.storage?.accounts.map(account => account.email)).toEqual(["second@example.test", "third@example.test"])
    expect(state.storage?.activeIndex).toBe(0)
    expect(state.storage?.activeIndexByFamily).toEqual({ claude: 0, gemini: 1 })
  })

  it("keeps selection and deletion identities stable when native resolution rotates a token", async () => {
    const { handlers } = await host(true)
    const [account] = await handlers.list({}, callContext)
    const id = account!.id
    await handlers.update({ id, action: "select" }, callContext)
    expect(state.storage?.activeIndex).toBe(0)
    expect(state.storage?.accounts[0]?.refreshToken).toBe("rotated-secret")
    expect(await handlers.connections({ id }, callContext)).toEqual({ ids: ["native-first"] })
    await handlers.update({ id, action: "delete" }, callContext)
    expect(state.storage?.accounts).toHaveLength(2)
    expect(state.storage?.accounts.some(item => item.id === id)).toBe(false)
  })

  it("preserves a concurrent disable when a quota check updates project metadata", async () => {
    const { handlers } = await host()
    const [account] = await handlers.list({}, callContext)
    vi.mocked(checkAccountsQuota).mockImplementationOnce(async accounts => {
      const original = accounts[0]!
      state.storage!.accounts[0]!.enabled = false
      return [{ index: 0, status: "ok", updatedAccount: { ...original, managedProjectId: "discovered-project" } }]
    })
    await handlers.quotas({ id: account!.id }, callContext)
    expect(state.storage?.accounts[0]).toMatchObject({ enabled: false, managedProjectId: "discovered-project" })
  })

  it.each(["disable", "delete"] as const)("preserves a %s committed immediately before quota metadata acquires the storage lock", async action => {
    const { handlers } = await host()
    const [account] = await handlers.list({}, callContext)
    vi.mocked(checkAccountsQuota).mockImplementationOnce(async accounts => [{ index: 0, status: "ok", updatedAccount: { ...accounts[0]!, managedProjectId: "discovered-project" } }])
    state.beforeUpdate = () => {
      state.beforeUpdate = undefined
      if (action === "disable") state.storage!.accounts[0]!.enabled = false
      else state.storage!.accounts.shift()
    }
    await handlers.quotas({ id: account!.id }, callContext)
    if (action === "disable") expect(state.storage!.accounts[0]!.enabled).toBe(false)
    else expect(state.storage!.accounts.some(item => item.id === account!.id)).toBe(false)
  })
})

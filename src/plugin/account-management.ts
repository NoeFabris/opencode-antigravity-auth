import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { AntigravityAccountsRpc, type AccountSummary } from "./account-rpc.ts"
import { parseRefreshParts } from "./auth.ts"
import { checkAccountsQuota } from "./quota.ts"
import { accountTokenHash, loadAccounts, matchesAccountToken, saveAccountCredentials, updateAccountCredentials, updateAccounts, type AccountMetadataV3 } from "./storage.ts"
import type { PluginClient } from "./types.ts"

export const accountID = (account: Pick<AccountMetadataV3, "id" | "refreshToken">) => account.id ?? accountTokenHash(account.refreshToken)
export const accountPoolIdentity = (accounts: AccountMetadataV3[]) => createHash("sha256")
  .update(accounts.filter(account => account.enabled !== false).map(accountID).sort().join(":")).digest("hex")
export const accountCredentialsIdentity = (accounts: AccountMetadataV3[]) => createHash("sha256")
  .update(accounts.filter(account => account.enabled !== false).map(account => account.refreshToken).sort().join("\0")).digest("hex")

export async function loadManagedAccounts() {
  const storage = await loadAccounts()
  if (storage?.accounts.some(account => !account.id)) {
    return updateAccounts(latest => {
      for (const account of latest.accounts) account.id ??= accountID(account)
    })
  }
  return storage
}

/** Pair the lowest usable cached fraction with its own reset time. */
function summarizeCachedQuota(account: AccountMetadataV3): AccountSummary["quota"] {
  let quota: AccountSummary["quota"]
  for (const group of Object.values(account.cachedQuota ?? {})) {
    if (!group || typeof group !== "object") continue
    const remainingFraction = group.remainingFraction
    if (remainingFraction === undefined || !Number.isFinite(remainingFraction) || remainingFraction < 0 || remainingFraction > 1) continue
    if (!quota || remainingFraction < quota.remainingFraction) {
      // Older multi-model caches only record the earliest reset in the group,
      // which may belong to a model with a different remaining fraction.
      const resetTime = group.remainingFractionResetTime ?? (group.modelCount === 1 ? group.resetTime : undefined)
      quota = { remainingFraction, resetTime: typeof resetTime === "string" ? resetTime : undefined, updatedAt: account.cachedQuotaUpdatedAt }
    }
  }
  return quota
}

export async function registerAccountManagement(
  ctx: Plugin.Context,
  client: PluginClient,
  beforeWrite: () => Promise<void>,
  refreshModels: () => Promise<number>,
  afterWrite: () => Promise<void> = async () => undefined,
  runCredentialOperation: <T>(operation: () => Promise<T>) => Promise<T> = operation => operation(),
) {
  const readAccounts = loadManagedAccounts

  async function list(): Promise<AccountSummary[]> {
    const storage = await readAccounts()
    if (!storage) return []
    return storage.accounts.map((account, index) => ({
      id: accountID(account), email: account.email ?? `Account ${index + 1}`,
      enabled: account.enabled !== false, current: index === storage.activeIndex,
      verificationRequired: account.verificationRequired === true, lastUsed: account.lastUsed ?? 0,
      quota: summarizeCachedQuota(account),
    }))
  }

  // Resolving a native connection may refresh OAuth. Do this only for explicit
  // selection or deletion, never merely to display the saved-account menu.
  async function connections(id: string): Promise<string[]> {
    const storage = await readAccounts()
    const account = storage?.accounts.find(item => accountID(item) === id)
    if (!account) return []
    const integration = await ctx.integration.get({ integrationID: "google" })
    const ids: string[] = []
    for (const connection of integration.data.connections) {
      if (connection.type !== "credential" || connection.method !== "oauth") continue
      const value = await ctx.integration.connection.resolve(connection)
      // Resolution can refresh and rotate the token. Compare the newly saved
      // account, using the persistent ID captured before resolution.
      const current = (await readAccounts())?.accounts.find(item => accountID(item) === id)
      const boundID = await ctx.storage.get(`connection-account:${connection.id}`)
      if (value?.type === "oauth" && current && (boundID === id || value.metadata?.antigravityAccountId === id || matchesAccountToken(current, parseRefreshParts(value.refresh).refreshToken))) {
        await ctx.storage.set(`connection-account:${connection.id}`, id)
        ids.push(connection.id)
      }
    }
    return ids
  }

  return ctx.rpc.register(AntigravityAccountsRpc, {
    list,
    async connections({ id }) { await beforeWrite(); return { ids: await connections(id) } },
    async quotas({ id }) {
      return runCredentialOperation(async () => {
        const storage = await readAccounts()
        const accounts = (storage?.accounts ?? []).filter(account => !id || accountID(account) === id)
        if (!accounts.length) return { report: "No saved accounts. Add a Google account first.", accounts: [] }
        const results = await checkAccountsQuota(accounts, client, "google", { includeDisabled: !!id, onAccountUpdated: saveAccountCredentials })
        const lines: string[] = []
        const reports: Array<{ id: string; email: string; disabled: boolean; report: string }> = []
        for (const result of results) {
          const original = accounts[result.index]
          if (!original) continue
          const firstLine = lines.length
          const finish = () => reports.push({ id: accountID(original), email: original.email ?? `Account ${result.index + 1}`, disabled: result.disabled === true, report: lines.slice(firstLine).join("\n").trim() })
          lines.push(`${original.email ?? `Account ${result.index + 1}`}${result.disabled ? " [disabled]" : ""}`)
          if (result.status === "disabled") { lines.push("  Skipped (disabled)", ""); finish(); continue }
          if (result.error) { lines.push(`  ${result.error}`, ""); finish(); continue }
          for (const [group, quota] of Object.entries(result.quota?.groups ?? {})) {
            const percent = quota.remainingFraction === undefined ? "unknown" : `${Math.round(quota.remainingFraction * 100)}% remaining`
            lines.push(`  Antigravity ${group}: ${percent}${quota.resetTime ? `; resets ${quota.resetTime}` : ""}`)
          }
          if (result.quota?.error) lines.push(`  Antigravity: ${result.quota.error}`)
          for (const quota of result.geminiCliQuota?.models ?? []) {
            lines.push(`  Gemini CLI ${quota.modelId}: ${Math.round(quota.remainingFraction * 100)}% remaining${quota.resetTime ? `; resets ${quota.resetTime}` : ""}`)
          }
          if (result.geminiCliQuota?.error) lines.push(`  Gemini CLI: ${result.geminiCliQuota.error}`)
          lines.push("")
          finish()
        }
        await updateAccounts(latest => {
          for (const result of results) {
            const original = accounts[result.index]
            if (!original) continue
            const account = latest.accounts.find(item => accountID(item) === accountID(original))
            if (account) {
              if (result.updatedAccount && account.refreshToken === original.refreshToken) {
                updateAccountCredentials(account, result.updatedAccount)
              }
              if (result.quota && !result.quota.error) {
                account.cachedQuota = result.quota.groups
                account.cachedQuotaUpdatedAt = Date.now()
              }
            }
          }
      })
      return { report: lines.join("\n").trim(), accounts: reports }
      })
    },
    async update({ id, action }) {
      await beforeWrite()
      const credentialID = action === "select" ? (await connections(id))[0] : undefined
      const storage = await readAccounts()
      const index = storage?.accounts.findIndex(account => accountID(account) === id) ?? -1
      const account = storage?.accounts[index]
      if (!storage || !account) throw new Error("Account no longer exists; reopen the menu.")
      if (action === "select" && account.enabled === false) throw new Error("Enable this account before selecting it.")
      if (action === "select" && credentialID) await ctx.credential.activate({ credentialID })
      // Keep a pool selection until the user switches the native connection.
      if (action === "select") {
        const active = await ctx.integration.connection.active("google")
        await ctx.storage.set("pool-selection", active?.type === "credential" ? active.id : "pool")
      }
      await updateAccounts(storage => {
        const index = storage.accounts.findIndex(account => accountID(account) === id)
        const account = storage.accounts[index]
        if (!account) throw new Error("Account no longer exists; reopen the menu.")
        if (action === "select" && account.enabled === false) throw new Error("Enable this account before selecting it.")
        if (action === "enable" || action === "disable") account.enabled = action === "enable"
        if (action === "select") {
          storage.activeIndex = index
          storage.activeIndexByFamily = { claude: index, gemini: index }
        }
        if (action === "delete") {
          const cursors = { active: storage.accounts[storage.activeIndex], claude: storage.accounts[storage.activeIndexByFamily?.claude ?? storage.activeIndex], gemini: storage.accounts[storage.activeIndexByFamily?.gemini ?? storage.activeIndex] }
          storage.accounts.splice(index, 1)
          const cursor = (selected?: AccountMetadataV3) => {
            const found = storage.accounts.findIndex(item => item === selected && item.enabled !== false)
            return found >= 0 ? found : Math.max(0, storage.accounts.findIndex(item => item.enabled !== false))
          }
          storage.activeIndex = cursor(cursors.active)
          storage.activeIndexByFamily = { claude: cursor(cursors.claude), gemini: cursor(cursors.gemini) }
        } else {
          if (storage.accounts[storage.activeIndex]?.enabled === false) {
            storage.activeIndex = Math.max(0, storage.accounts.findIndex(item => item.enabled !== false))
            storage.activeIndexByFamily = { claude: storage.activeIndex, gemini: storage.activeIndex }
          }
        }
      })
      await ctx.storage.remove("model-catalog")
      await afterWrite()
      return { message: action === "select" ? "Account selected" : action === "delete" ? "Account deleted" : action === "enable" ? "Account enabled" : "Account disabled" }
    },
    async models() { return { count: await refreshModels() } },
  })
}

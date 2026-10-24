import type { Plugin } from "@opencode/plugin/tui"
import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { AntigravityAccountsRpc, type AccountQuota, type AccountSummary } from "./plugin/account-rpc.ts"

/** Formats cached quota for the account list, e.g. "81% · resets in 2h 54m". */
export function formatAccountQuota(quota: AccountQuota | undefined, now = Date.now()) {
  if (!quota) return "no quota data"
  const percent = `${Math.round(quota.remainingFraction * 100)}%`
  const reset = quota.resetTime ? Date.parse(quota.resetTime) : Number.NaN
  // A full quota has nothing to reset, and an elapsed reset has no countdown left.
  if (quota.remainingFraction >= 1 || Number.isNaN(reset) || reset <= now) return percent
  const minutes = Math.max(1, Math.round((reset - now) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const until = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
  return `${percent} · resets in ${until}`
}

const accountTitle = (account: AccountSummary) =>
  `${account.email}${account.current ? " [current]" : ""}${account.enabled ? "" : " [disabled]"}${account.verificationRequired ? " [needs verification]" : ""}`

// This plugin uses host dialogs and renders no JSX. Keep its public declarations
// independent of the SDK's optional Solid/OpenTUI rendering dependencies.
interface AccountMenuContext {
  readonly client: OpenCodeClient
  readonly location: LocationRef | undefined
  readonly data: { readonly location: { default(): LocationRef } }
  readonly ui: {
    readonly dialog: {
      prompt(options: { title: string; description?: string }): Promise<string | undefined>
      alert(options: { title: string; message: string }): Promise<void>
      confirm(options: { title: string; message: string }): Promise<boolean | undefined>
      select<Value>(options: { title: string; options: ReadonlyArray<{ title: string; value: Value; description?: string; category?: string; disabled?: boolean }> }): Promise<Value | undefined>
    }
    readonly toast: { show(options: { message: string; variant: "info" | "success" }): void }
  }
  readonly keymap: {
    layer(factory: () => { mode: "global"; commands: ReadonlyArray<{
      id: string; title: string; group: string; palette: true
      slash: { name: string; aliases: string[] }; run: () => Promise<void>
    }> }): void
  }
}

export const AntigravityTuiPlugin = {
  id: "opencode-antigravity-auth",
  setup(ctx: AccountMenuContext) {
    const rpc = ctx.client.rpc(AntigravityAccountsRpc)
    const location = () => ({ location: ctx.location ?? ctx.data.location.default() })

    async function login() {
      const { data: attempt } = await ctx.client.integration.oauth.connect({
        integrationID: "google", methodID: "antigravity", answer: { manual: true }, ...location(),
      })
      let completed = false
      try {
        const code = await ctx.ui.dialog.prompt({ title: "Connect Google (Antigravity)", description: `${attempt.instructions}\n\n${attempt.url}` })
        if (!code?.trim()) return
        await ctx.client.integration.oauth.complete({ integrationID: "google", attemptID: attempt.attemptID, code: code.trim(), ...location() })
        completed = true
        await rpc.models({}, location())
        ctx.ui.toast.show({ message: "Google account connected", variant: "success" })
      } finally {
        if (!completed) await ctx.client.integration.oauth.cancel({ integrationID: "google", attemptID: attempt.attemptID, ...location() })
      }
    }

    async function quotas(id?: string) {
      ctx.ui.toast.show({ message: "Checking account access and quotas…", variant: "info" })
      const result = await rpc.quotas(id ? { id } : {}, location())
      const reports = result.accounts.filter(account => id || !account.disabled)
      if (reports.length <= 1) {
        await ctx.ui.dialog.alert({ title: "Antigravity quotas", message: reports[0]?.report ?? result.report })
        return
      }
      while (true) {
        const selected = await ctx.ui.dialog.select({
          title: "Antigravity quotas",
          options: reports.map(account => ({ title: account.email, value: account.id, description: account.report.split("\n").slice(1, 4).join("; ") })),
        })
        const report = reports.find(account => account.id === selected)
        if (!report) return
        await ctx.ui.dialog.alert({ title: report.email, message: report.report })
      }
    }

    async function accountMenu(account: AccountSummary) {
      const action = await ctx.ui.dialog.select({
        title: account.email,
        options: [
          { title: "Check quotas / verify access", value: "verify" },
          { title: "Use this account", value: "select", disabled: !account.enabled },
          { title: account.enabled ? "Disable account" : "Enable account", value: account.enabled ? "disable" : "enable" },
          { title: "Re-authenticate / refresh token", value: "login" },
          { title: "Delete this account", value: "delete" },
          { title: "Back", value: "back" },
        ],
      })
      if (!action || action === "back") return
      if (action === "verify") return quotas(account.id)
      if (action === "login") return login()
      if (action === "delete") {
        if (!await ctx.ui.dialog.confirm({ title: "Delete account?", message: `Remove ${account.email} from OpenCode and the Antigravity account pool?` })) return
        const { ids } = await rpc.connections({ id: account.id }, location())
        for (const credentialID of ids) await ctx.client.credential.remove({ credentialID })
      }
      if (action !== "enable" && action !== "disable" && action !== "select" && action !== "delete") return
      const result = await rpc.update({ id: account.id, action }, location())
      ctx.ui.toast.show({ message: result.message, variant: "success" })
    }

    async function manage(accounts: ReadonlyArray<AccountSummary>) {
      const selected = await ctx.ui.dialog.select({
        title: "Manage account",
        options: accounts.map(account => ({ title: accountTitle(account), value: account.id })),
      })
      const account = accounts.find(item => item.id === selected)
      if (account) await accountMenu(account)
    }

    async function menu() {
      try {
        while (true) {
          const accounts = await rpc.list({}, location())
          const action = await ctx.ui.dialog.select({
            title: "Google accounts (Antigravity)",
            options: [
              { title: "Add account", value: "add", category: "Actions" },
              { title: "Check quotas / verify enabled accounts", value: "quotas", category: "Actions" },
              { title: "Refresh available models", value: "models", category: "Actions" },
              { title: "Manage an account…", value: "manage", category: "Actions" },
              ...accounts.map(account => ({
                title: accountTitle(account),
                value: account.id,
                description: formatAccountQuota(account.quota),
                category: "Accounts",
                disabled: !account.enabled,
              })),
              { title: "Close", value: "close", category: "Actions" },
            ],
          })
          if (!action || action === "close") return
          if (action === "add") await login()
          else if (action === "quotas") await quotas()
          else if (action === "models") {
            const { count } = await rpc.models({}, location())
            ctx.ui.toast.show({ message: `${count} available models loaded`, variant: "success" })
          } else if (action === "manage") await manage(accounts)
          else {
            // Picking an account switches to it, like the model picker.
            const account = accounts.find(item => item.id === action)
            if (!account?.enabled) continue
            if (!account.current) {
              const result = await rpc.update({ id: account.id, action: "select" }, location())
              ctx.ui.toast.show({ message: `${result.message}: ${account.email}`, variant: "success" })
            }
            return
          }
        }
      } catch (error) {
        await ctx.ui.dialog.alert({ title: "Antigravity", message: error instanceof Error ? error.message : String(error) })
      }
    }

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "antigravity.accounts", title: "Antigravity accounts and quotas", group: "Antigravity",
        palette: true, slash: { name: "antigravity", aliases: ["ag"] }, run: menu,
      }],
    }))
  },
} satisfies Plugin.Definition

export default AntigravityTuiPlugin

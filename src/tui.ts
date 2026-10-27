import type { Plugin } from "@opencode/plugin/tui"
import type { LocationRef, OpenCodeClient } from "@opencode/client"
import { AntigravityAccountsRpc, type AccountSummary } from "./plugin/account-rpc.ts"
import { formatQuotaDescription } from "./plugin/ui/quota.ts"

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

    async function menu() {
      try {
        while (true) {
          const accounts = await rpc.list({}, location())
          const accountOptions = accounts.map(account => ({
            title: `${account.email}${account.current ? " [current]" : ""}${account.enabled ? "" : " [disabled]"}${account.verificationRequired ? " [needs verification]" : ""}`,
            value: account.id,
            description: formatQuotaDescription(account.quota),
            category: "Accounts",
          }))
          const action = await ctx.ui.dialog.select({
            title: "Google accounts (Antigravity)",
            options: [
              { title: "Add account", value: "add", category: "Actions" },
              { title: "Check quotas / verify enabled accounts", value: "quotas", category: "Actions" },
              { title: "Refresh available models", value: "models", category: "Actions" },
              { title: "Manage account…", value: "manage", category: "Actions" },
              ...accountOptions,
              { title: "Close", value: "close", category: "Actions" },
            ],
          })
          if (!action || action === "close") return
          if (action === "add") await login()
          else if (action === "quotas") await quotas()
          else if (action === "models") {
            const { count } = await rpc.models({}, location())
            ctx.ui.toast.show({ message: `${count} available models loaded`, variant: "success" })
          } else if (action === "manage") {
            const id = await ctx.ui.dialog.select({ title: "Manage Antigravity account", options: accountOptions })
            const account = accounts.find(item => item.id === id)
            if (account) await accountMenu(account)
          } else {
            const account = accounts.find(item => item.id === action)
            if (!account) continue
            if (!account.enabled) await accountMenu(account)
            else {
              const result = await rpc.update({ id: account.id, action: "select" }, location())
              ctx.ui.toast.show({ message: result.message, variant: "success" })
              return
            }
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

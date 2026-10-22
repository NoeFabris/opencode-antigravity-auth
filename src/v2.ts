import { AsyncLocalStorage } from "node:async_hooks"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { Credential, Integration, Model, Plugin, Provider } from "@opencode/plugin"

import { authorizeAntigravity, exchangeAntigravity } from "./antigravity/oauth.ts"
import { ANTIGRAVITY_REDIRECT_URI } from "./constants.ts"
import { createAntigravityPlugin } from "./plugin.ts"
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from "./plugin/auth.ts"
import { OPENCODE_V2_MODEL_DEFINITIONS, buildAccountModelDefinitions, ModelCatalogCacheSchema } from "./plugin/config/models-v2.ts"
import { accountID, accountPoolIdentity, accountCredentialsIdentity, loadManagedAccounts, registerAccountManagement } from "./plugin/account-management.ts"
import { checkAccountsQuota, type AvailableModel } from "./plugin/quota.ts"
import { createLogger } from "./plugin/logger.ts"
import { ensureProjectContext } from "./plugin/project.ts"
import { executeSearch, type SearchArgs } from "./plugin/search.ts"
import { startOAuthListener, type OAuthListener } from "./plugin/server.ts"
import { loadAccounts, matchesAccountToken, saveAccountCredentials, updateAccountCredentials, updateAccounts, type AccountMetadataV3 } from "./plugin/storage.ts"
import { AntigravityTokenRefreshError, refreshAccessToken } from "./plugin/token.ts"
import { resolveModelWithTier } from "./plugin/transform/model-resolver.ts"
import type { AuthDetails, LoaderResult, OAuthAuthDetails, PluginClient } from "./plugin/types.ts"

const PROVIDER_ID = "google"
const METHOD_ID = "antigravity"
// Core rewrites the standard Google SDK package to its native transport after
// every provider/model update. Its local module URL avoids that conversion and
// lets Core's earlier generic SDK loader use our installed dependency directly.
const SDK_PACKAGE = typeof import.meta.resolve === "function"
  ? import.meta.resolve("@ai-sdk/google")
  : pathToFileURL(createRequire(import.meta.url).resolve("@ai-sdk/google")).href
const GOOGLE_PACKAGE = `aisdk:${SDK_PACKAGE}`
const API_KEY_SENTINEL = "antigravity-oauth"
const ownsModel = (id: string) => id.startsWith("antigravity-")
type Registration = { dispose(): Promise<void> }
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function mergeBody(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const previous = result[key]
    if (value === undefined) continue
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      && previous && typeof previous === "object" && !Array.isArray(previous)
      ? mergeBody(previous as Record<string, unknown>, value as Record<string, unknown>)
      : value
  }
  return result
}

// V2 owns credentials, notifications and session repair. The legacy transport
// only needs these methods to be awaitable; it never writes V2 session files.
function transportClient(): PluginClient {
  const unusedSession = async () => {
    throw new Error("Legacy session recovery is unavailable in OpenCode V2")
  }
  return {
    app: { log: async () => undefined },
    auth: { set: async () => undefined },
    tui: { showToast: async () => undefined },
    session: { prompt: unusedSession, abort: unusedSession, messages: unusedSession },
  }
}

function oauthCredential(auth: OAuthAuthDetails, metadata?: Credential.OAuth["metadata"]): Credential.OAuth {
  return {
    type: "oauth",
    methodID: Integration.MethodID.make(METHOD_ID),
    refresh: auth.refresh,
    access: auth.access ?? "",
    expires: auth.expires ?? 0,
    ...(metadata ? { metadata } : {}),
  }
}

/** Recognizes Antigravity grants and V1 OAuth imports bound to this account pool. */
function isAntigravityCredential(value: Credential.Value | undefined, accounts: readonly AccountMetadataV3[] = [], boundID?: unknown): value is Credential.OAuth {
  if (value?.type !== "oauth" || !value.refresh) return false
  if (value.methodID === METHOD_ID) return true
  // V1 migration imports generic OAuth credentials; the pool establishes ownership.
  return value.methodID === "oauth" && (typeof boundID === "string"
    || accounts.some(account => matchesAccountToken(account, parseRefreshParts(value.refresh).refreshToken)))
}

/** OpenCode 2.1's source transforms and AI SDK 3 transport adapter. */
export const AntigravityV2Plugin = Plugin.define({
  id: "opencode-antigravity-auth",
  async setup(ctx) {
    const client = transportClient()
    const outbound = new AsyncLocalStorage<Fetch>()
    let modelAccounts: Record<string, string[]> = {}
    let accountCatalogLoaded = false
    const transport = await createAntigravityPlugin(PROVIDER_ID)({
      client,
      directory: ctx.location.directory,
      runtimeVersion: 2,
      canUseAccount: (account, model) => {
        const eligible = modelAccounts[`antigravity-${resolveModelWithTier(model).actualModel}`]
        return !accountCatalogLoaded || !!eligible?.includes(accountID(account))
      },
      fetch: (input, init) => {
        const send = outbound.getStore() ?? globalThis.fetch
        // Core's wrapper applies model.body to string init.body. It has already
        // been applied to the Google request before interception, so a Request
        // prevents applying that overlay again to the Antigravity envelope.
        const request = new Request(input, init)
        request.headers.delete("x-goog-api-key")
        return send(request, { signal: init?.signal })
      },
    })
    const registrations: Registration[] = []
    const saved = await loadManagedAccounts()
    let hasSavedAccounts = saved?.accounts.some((account) => account.enabled !== false && !!account.refreshToken)
    const log = createLogger("v2")
    const cachedResult = ModelCatalogCacheSchema.safeParse(await ctx.storage.get("model-catalog"))
    const cached = cachedResult.success ? cachedResult.data : undefined
    const validCache = cached?.identity === accountPoolIdentity(saved?.accounts ?? []) && cached.models
    let modelDefinitions = validCache ? buildAccountModelDefinitions(validCache) : OPENCODE_V2_MODEL_DEFINITIONS
    accountCatalogLoaded = !!validCache
    if (validCache) modelAccounts = cached.accounts
    let discoveryGeneration = 0
    let catalogSnapshot: Parameters<typeof ctx.storage.set>[1] | undefined
    const catalogWrites = new Set<Promise<void>>()
    const discoveries = new Set<Promise<number>>()
    const writeCatalog = async () => {
      let pending = catalogSnapshot
      while (pending !== undefined) {
        await ctx.storage.set("model-catalog", pending)
        if (pending === catalogSnapshot) return
        pending = catalogSnapshot
      }
    }
    const discoverModels = async () => {
      const discovery = ++discoveryGeneration
      await resolveAuth()
      const stored = await loadManagedAccounts()
      const accounts = stored?.accounts.filter(account => account.enabled !== false) ?? []
      hasSavedAccounts = accounts.length > 0
      if (!accounts.length) throw new Error("No enabled Google accounts. Add or enable an account first.")
      const results = await checkAccountsQuota(accounts, client, PROVIDER_ID, {
        onAccountUpdated: saveAccountCredentials,
        signal: lifetime.signal,
      })
      const successful = results.filter(result => result.quota?.models && Object.keys(result.quota.models).length)
      const models: Record<string, AvailableModel> = {}
      const eligibleAccounts: Record<string, string[]> = {}
      if (discovery === discoveryGeneration) {
        invalidateLoader()
        await transport.flush?.()
      }
      const latest = await updateAccounts(latest => {
        for (const result of results) {
          const original = accounts[result.index]
          if (!original) continue
          const account = latest.accounts.find(item => accountID(item) === accountID(original))
          if (!account) continue
          if (result.updatedAccount && account.refreshToken === original.refreshToken) {
            updateAccountCredentials(account, result.updatedAccount)
          }
          if (account.enabled === false) continue
          if (!result.quota?.models) continue
          for (const id of Object.keys(buildAccountModelDefinitions(result.quota.models))) {
            (eligibleAccounts[id] ??= []).push(accountID(account))
          }
          for (const [id, model] of Object.entries(result.quota?.models ?? {})) {
            const usable = (value: AvailableModel) => !value.disabled && value.selectable !== false
            if (!models[id] || !usable(models[id]) || usable(model)) models[id] = model
          }
        }
      })
      // Credentials remain valuable after a concurrent pool change, but only
      // the newest complete discovery for this pool may replace the catalog.
      if (disposed || discovery !== discoveryGeneration || accountPoolIdentity(latest?.accounts ?? []) !== accountPoolIdentity(accounts)) return Object.keys(modelDefinitions).length
      if (!successful.length) throw new Error(results.find(result => result.error)?.error ?? "Google did not return a model catalog. Check account access and try again.")
      modelDefinitions = buildAccountModelDefinitions(models)
      modelAccounts = eligibleAccounts
      accountCatalogLoaded = true
      catalogSnapshot = JSON.parse(JSON.stringify({ version: 3, identity: accountPoolIdentity(latest?.accounts ?? []), updatedAt: Date.now(), models, accounts: eligibleAccounts }))
      const writing = writeCatalog()
      catalogWrites.add(writing)
      try { await writing } finally { catalogWrites.delete(writing) }
      await ctx.provider.reload()
      return Object.keys(modelDefinitions).length
    }
    const refreshModels = () => {
      if (disposed) return Promise.reject(new Error("Antigravity plugin has been disposed"))
      const discovering = discoverModels()
      discoveries.add(discovering)
      void discovering.then(() => discoveries.delete(discovering), () => discoveries.delete(discovering))
      return discovering
    }
    const listeners = new Set<OAuthListener>()
    const lifetime = new AbortController()
    let requestLifetime = new AbortController()
    let disposed = false
    const credentialOperations = new Set<Promise<unknown>>()
    const runCredentialOperation = <T>(operation: () => Promise<T>): Promise<T> => {
      if (disposed) return Promise.reject(new Error("Antigravity plugin has been disposed"))
      const running = operation()
      credentialOperations.add(running)
      void running.then(() => credentialOperations.delete(running), () => credentialOperations.delete(running))
      return running
    }
    let loader: LoaderResult | undefined
    let loaderIdentity: string | undefined
    let generation = 0
    let observedIdentity: string | undefined
    let loading: Promise<LoaderResult | undefined> | undefined
    let usesAntigravityOAuth = false
    let modelReloadPending = false
    let connectionEvents: Promise<void> | undefined
    let modelAccessRefresh = Promise.resolve()

    type ResolvedAuth = { auth: OAuthAuthDetails; identity: string; select: boolean; accountID?: string }
    const observeAuth = (resolved: ResolvedAuth | undefined) => {
      if (observedIdentity !== resolved?.identity) {
        observedIdentity = resolved?.identity
        generation += 1
        loader = undefined
        loaderIdentity = undefined
      }
      return resolved
    }
    const resolveAuth = async (): Promise<ResolvedAuth | undefined> => {
      const connection = await ctx.integration.connection.active(PROVIDER_ID)
      let poolSelection = await ctx.storage.get("pool-selection")
      const connectionID = connection?.type === "credential" ? connection.id : "pool"
      if (poolSelection && poolSelection !== connectionID) {
        await ctx.storage.remove("pool-selection")
        poolSelection = undefined
      }
      if (connection) {
        const value = await ctx.integration.connection.resolve(connection)
        const stored = await loadAccounts()
        const bindingKey = connection.type === "credential" ? `connection-account:${connection.id}` : undefined
        const boundID = bindingKey ? await ctx.storage.get(bindingKey) : undefined
        if (!isAntigravityCredential(value, stored?.accounts, boundID)) return observeAuth(undefined)
        // V1 credentials are imported with a generic method ID. Only matching
        // this plugin's existing pool establishes their Antigravity ownership.
        const metadataID = value.metadata?.antigravityAccountId
        const account = stored?.accounts.find(item => matchesAccountToken(item, parseRefreshParts(value.refresh).refreshToken))
          ?? stored?.accounts.find(item => (typeof metadataID === "string" && item.id === metadataID) || (typeof boundID === "string" && item.id === boundID) || (typeof value.metadata?.email === "string" && item.email === value.metadata.email))
        if (account && bindingKey) await ctx.storage.set(bindingKey, accountID(account))
        const knownAccountRemoved = (typeof metadataID === "string" || typeof boundID === "string") && !account
        if (account?.enabled !== false && poolSelection !== "pool" && (connection.type !== "credential" || poolSelection !== connection.id)) {
          if (!knownAccountRemoved) {
            const auth = account ? { ...value, refresh: formatRefreshParts(account) } : value
            return observeAuth({ auth, identity: `credential:${parseRefreshParts(auth.refresh).refreshToken}:${accountCredentialsIdentity(stored?.accounts ?? [])}`, select: true, accountID: account && accountID(account) })
          }
        }
      }
      // The independent pool also supports V1 migration without a connection.
      const stored = await loadAccounts()
      const active = stored?.accounts[stored.activeIndex]
      const account = active?.enabled !== false && active?.refreshToken
        ? active
        : stored?.accounts.find((item) => item.enabled !== false && item.refreshToken)
      return observeAuth(account ? {
        auth: { type: "oauth", refresh: formatRefreshParts(account) },
        // Cursor changes preserve rotation state; credential rotation rebuilds
        // a manager before it can attempt to refresh an obsolete token.
        identity: `account-pool:${accountCredentialsIdentity(stored?.accounts ?? [])}`,
        select: false,
        accountID: accountID(account),
      } : undefined)
    }
    const currentAuth = async () => (await resolveAuth())?.auth
    /** Reconciles credential ownership and retries catalog reloads until one succeeds. */
    const refreshModelAccess = (reload: boolean) => {
      // Read changes in order, including switches during the initial resolution.
      modelAccessRefresh = modelAccessRefresh.then(async () => {
        try {
          const connection = await ctx.integration.connection.active(PROVIDER_ID)
          const value = connection ? await ctx.integration.connection.resolve(connection) : undefined
          const stored = value?.type === "oauth" && value.methodID === "oauth" ? await loadAccounts() : undefined
          const boundID = connection?.type === "credential" ? await ctx.storage.get(`connection-account:${connection.id}`) : undefined
          const next = isAntigravityCredential(value, stored?.accounts, boundID)
          if (disposed || (next === usesAntigravityOAuth && !modelReloadPending)) return
          usesAntigravityOAuth = next
          if (reload) {
            modelReloadPending = true
            await ctx.model.reload()
            modelReloadPending = false
          }
        } catch (error) {
          if (!disposed) log.warn("Could not update Google model authentication", { error: String(error) })
        }
      })
      return modelAccessRefresh
    }
    const invalidateLoader = (abortRequests = true) => {
      generation += 1
      if (abortRequests) {
        requestLifetime.abort(new Error("Antigravity accounts changed"))
        requestLifetime = new AbortController()
      }
      loader = undefined
      loaderIdentity = undefined
    }

    const rememberAuth = async (auth: OAuthAuthDetails, email?: string, previous?: Credential.OAuth) => {
      const parts = parseRefreshParts(auth.refresh)
      if (previous) {
        let remembered = false
        const originalToken = parseRefreshParts(previous.refresh).refreshToken
        const saved = await updateAccounts(storage => {
          const account = storage.accounts.find(item => matchesAccountToken(item, originalToken) || (typeof previous.metadata?.antigravityAccountId === "string" && item.id === previous.metadata.antigravityAccountId))
          if (!account) return
          remembered = true
          if (account.refreshToken === originalToken) {
            updateAccountCredentials(account, parts)
          }
        })
        if (remembered) return saved?.accounts.find(item => item.refreshToken === parts.refreshToken || item.id === previous.metadata?.antigravityAccountId)
        // A saved native credential may outlive an explicitly deleted pool entry.
        if (previous.metadata?.antigravityAccountId) return undefined
      }
      const saved = await updateAccounts(storage => {
        const account = storage.accounts.find(item => matchesAccountToken(item, parts.refreshToken) || (!!email && item.email === email))
        if (account) {
          updateAccountCredentials(account, parts)
          account.email = email ?? account.email
        } else {
          storage.accounts.push({ id: accountID({ refreshToken: parts.refreshToken }), refreshToken: parts.refreshToken, projectId: parts.projectId, managedProjectId: parts.managedProjectId, email, enabled: true, addedAt: Date.now(), lastUsed: 0 })
        }
      })
      return saved?.accounts.find(item => item.refreshToken === parts.refreshToken)
    }

    const getLoader = async (): Promise<LoaderResult> => {
      if (disposed) throw new Error("Antigravity plugin has been disposed")
      const resolved = await resolveAuth()
      if (!resolved) throw new Error("Connect Google with Antigravity OAuth to use this model")
      const { auth, identity } = resolved
      if (loader && loaderIdentity === identity) return loader
      if (loading) { await loading; return getLoader() }
      const expectedGeneration = generation
      loading = (async () => {
        // Finish an older manager's pending save before selecting a new
        // connection, so it cannot overwrite the newly selected cursors.
        await transport.flush?.()
        if (generation !== expectedGeneration) return undefined
        const token = parseRefreshParts(auth.refresh).refreshToken
        let stored = await loadAccounts()
        if (generation !== expectedGeneration) return undefined
        if (!stored?.accounts.some((account) => account.refreshToken === token)) {
          // A resolved pool member can disappear or rotate during I/O. Only a
          // previously unknown native credential may add a new pool member.
          if (resolved.accountID) return undefined
          const latest = await resolveAuth()
          if (generation !== expectedGeneration || latest?.identity !== identity) return undefined
          await rememberAuth(auth)
          return undefined
        }
        if (resolved.select && stored) {
          const index = stored.accounts.findIndex((account) => account.refreshToken === token && account.enabled !== false)
          if (index >= 0) {
            stored.activeIndex = index
            stored.activeIndexByFamily = { claude: index, gemini: index }
            await updateAccounts(latest => {
              const selected = latest.accounts.findIndex(account => account.refreshToken === token && account.enabled !== false)
              if (selected >= 0) {
                latest.activeIndex = selected
                latest.activeIndexByFamily = { claude: selected, gemini: selected }
              }
            })
          }
        }
        let result: Awaited<ReturnType<typeof transport.auth.loader>>
        try {
          result = await transport.auth.loader(async (): Promise<AuthDetails> =>
            await currentAuth() ?? { type: "none" }, {})
        } catch (error) {
          if (!disposed && generation !== expectedGeneration) return undefined
          throw error
        }
        if (typeof result.fetch !== "function") throw new Error("Antigravity OAuth is unavailable")
        if (disposed) throw new Error("Antigravity plugin has been disposed")
        if (generation !== expectedGeneration) return undefined
        loader = result as LoaderResult
        loaderIdentity = identity
        return loader
      })()
      let result: LoaderResult | undefined
      try { result = await loading } finally { loading = undefined }
      return result ?? getLoader()
    }

    const scopedFetch = (fallback: unknown, body?: Model.Info["body"]): Fetch => (input, init) => runCredentialOperation(async () => {
      if (disposed) throw new Error("Antigravity plugin has been disposed")
      const original: Fetch = typeof fallback === "function" ? fallback as Fetch : globalThis.fetch
      if (!await currentAuth()) throw new Error("Connect Google with Antigravity OAuth and enable an account to use this model")
      if (body && typeof init?.body === "string") {
        init = { ...init, body: JSON.stringify(mergeBody(JSON.parse(init.body) as Record<string, unknown>, body)) }
      }
      const interceptor = await getLoader()
      const signal = AbortSignal.any([
        lifetime.signal,
        requestLifetime.signal,
        ...(init?.signal ? [init.signal] : input instanceof Request ? [input.signal] : []),
      ])
      return outbound.run(original, () => interceptor.fetch(input instanceof URL ? input.toString() : input, { ...init, signal }))
    })

    let cleaning: Promise<void> | undefined
    const cleanup = () => {
      if (cleaning) return cleaning
      disposed = true
      cleaning = Promise.resolve().then(async () => {
        lifetime.abort(new Error("Antigravity plugin disposed"))
        await Promise.allSettled([...listeners].map((listener) => listener.close()))
        await Promise.allSettled([...credentialOperations])
        await connectionEvents
        await Promise.allSettled([...discoveries])
        await Promise.allSettled([...catalogWrites])
        await Promise.allSettled(registrations.reverse().map((registration) => registration.dispose()))
        await transport.dispose?.()
        loader = undefined
      })
      return cleaning
    }

    try {
      registrations.push(await ctx.integration.transform((editor) => {
        editor.method.update({
          integrationID: PROVIDER_ID,
          method: {
            id: METHOD_ID,
            type: "oauth",
            label: "Google OAuth (Antigravity)",
            form: [
              { key: "projectId", type: "string", title: "Google Cloud project ID (optional)" },
              { key: "manual", type: "boolean", title: "Paste an authorization code or callback URL", default: true },
            ],
          },
          async authorize(answer) {
            return runCredentialOperation(async () => {
              const auth = await authorizeAntigravity(typeof answer.projectId === "string" ? answer.projectId : "")
              if (disposed) throw new Error("Antigravity plugin has been disposed")
              const state = new URL(auth.url).searchParams.get("state")
              if (!state) throw new Error("Antigravity authorization did not provide OAuth state")
              const complete = (input: string) => runCredentialOperation(async () => {
                let code = input.trim()
                if (/^https?:\/\//i.test(code)) {
                  const callback = new URL(code)
                  const redirect = new URL(ANTIGRAVITY_REDIRECT_URI)
                  if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.searchParams.get("state") !== state) {
                    throw new Error("Invalid Antigravity OAuth callback URL or state")
                  }
                  code = callback.searchParams.get("code") ?? ""
                }
                if (!code) throw new Error("Missing Antigravity authorization code")
                const result = await exchangeAntigravity(code, state)
                if (result.type !== "success") throw new Error("Antigravity authorization failed; please try signing in again")
                const account = await rememberAuth({ ...result, type: "oauth" }, result.email)
                await updateAccounts(accounts => {
                  const current = accounts.accounts.find(item => item.id === account?.id)
                  if (!current) return
                  current.enabled = true
                  current.verificationRequired = false
                  delete current.verificationRequiredAt
                  delete current.verificationRequiredReason
                  delete current.verificationUrl
                })
                await ctx.storage.remove("pool-selection")
                invalidateLoader()
                return oauthCredential({ ...result, type: "oauth" }, { ...(result.email ? { email: result.email } : {}), ...(account?.id ? { antigravityAccountId: account.id } : {}) })
              })
              if (answer.manual !== false) {
                return { url: auth.url, instructions: "Open this URL, then paste the authorization code or full callback URL.", mode: "code", callback: complete }
              }
              const listener = await startOAuthListener()
              listeners.add(listener)
              const callback = listener.waitForCallback()
                .then((url) => complete(url.toString()))
                .finally(async () => {
                  listeners.delete(listener)
                  await listener.close()
                })
              // The host consumes this promise after returning the authorization.
              void callback.catch(() => undefined)
              if (disposed) {
                await listener.close()
                throw new Error("Antigravity plugin has been disposed")
              }
              return { url: auth.url, instructions: "Open this URL in your browser to connect Antigravity.", mode: "auto", callback }
            })
          },
          async refresh(credential) {
            return runCredentialOperation(async () => {
              const sourceConnection = await ctx.integration.connection.active(PROVIDER_ID)
              const stored = await loadManagedAccounts()
              const original = stored?.accounts.find(account => matchesAccountToken(account, parseRefreshParts(credential.refresh).refreshToken) || (typeof credential.metadata?.antigravityAccountId === "string" && account.id === credential.metadata.antigravityAccountId))
              const previous = original?.id ? { ...credential, refresh: formatRefreshParts(original), metadata: { ...credential.metadata, antigravityAccountId: original.id } } : credential
              try {
                const refreshed = await refreshAccessToken(previous, client, PROVIDER_ID)
                if (!refreshed?.access) throw new Error("Antigravity token refresh temporarily unavailable")
                const account = await rememberAuth(refreshed, original?.email, previous)
                invalidateLoader(false)
                return oauthCredential(account ? { ...refreshed, refresh: formatRefreshParts(account) } : refreshed, { ...credential.metadata, ...(account?.id ? { antigravityAccountId: account.id } : {}) })
              } catch (error) {
                if (error instanceof AntigravityTokenRefreshError && error.code === "invalid_grant") {
                  let revoked = false
                  await updateAccounts(stored => {
                    const account = stored.accounts.find(item => item.refreshToken === parseRefreshParts(previous.refresh).refreshToken)
                    if (account) { account.enabled = false; revoked = true }
                  })
                  const boundID = sourceConnection?.type === "credential" ? await ctx.storage.get(`connection-account:${sourceConnection.id}`) : undefined
                  if (revoked && sourceConnection && typeof boundID === "string" && boundID === original?.id) await ctx.integration.connection.status({ integrationID: PROVIDER_ID, connection: sourceConnection, status: { status: "needs_auth", message: "Google revoked this account; sign in again." } })
                  invalidateLoader()
                }
                // Core resolves credentials before model construction. Keep that
                // step available so the transport can rotate to another account.
                // Six minutes clears Core's five-minute refresh buffer briefly.
                return { ...credential, access: "", expires: Date.now() + 6 * 60_000 }
              }
            })
          },
          label: (credential) => typeof credential.metadata?.email === "string" ? credential.metadata.email : undefined,
        })
      }))

      connectionEvents = (async () => {
        for await (const event of ctx.event.subscribe({ signal: lifetime.signal })) {
          if (event.type === "credential.updated" || event.type === "integration.updated"
            || (event.type === "credential.switched" && event.data.integrationID === PROVIDER_ID)) {
            await refreshModelAccess(true)
          }
        }
      })().catch(error => {
        if (!disposed) log.warn("Google connection event stream stopped", { error: String(error) })
      })
      await refreshModelAccess(false)

      registrations.push(await ctx.provider.transform((editor) => {
        // Keep the native Google provider and every unrelated model intact.
        // Only a missing provider (e.g. a minimal host) needs a source template.
        if (!editor.get(PROVIDER_ID)) {
          editor.add({
            info: { ...Provider.Info.empty(Provider.ID.google), name: "Google", package: GOOGLE_PACKAGE },
            models: [],
          })
        }
        if (hasSavedAccounts) {
          editor.update(PROVIDER_ID, (provider) => {
            if (provider.activation === "auto") provider.activation = "enabled"
          })
        }
        if (accountCatalogLoaded) {
          for (const id of editor.get(PROVIDER_ID)?.models.keys() ?? []) {
            if (ownsModel(id) && !modelDefinitions[id]) editor.models.remove(PROVIDER_ID, id)
          }
        }
        for (const [id, definition] of Object.entries(modelDefinitions)) {
          editor.models.update(PROVIDER_ID, id, (model) => {
            Object.assign(model, structuredClone(definition), { package: GOOGLE_PACKAGE })
            model.variants = structuredClone(definition.variants).map((variant) => ({ ...variant, id: Model.VariantID.make(variant.id) }))
          })
        }
      }))

      registrations.push(await ctx.model.transform((editor) => {
        for (const model of editor.list(PROVIDER_ID)) {
          const id = String(model.id)
          if (!ownsModel(id)) {
            // Core uses OAuth access tokens as API keys on the native Google
            // route. Only the Antigravity catalog can use this connection.
            if (usesAntigravityOAuth) editor.update(PROVIDER_ID, id, target => { target.enabled = false })
            continue
          }
          if (accountCatalogLoaded && !modelDefinitions[id]) {
            // Configured models are raw overrides. Removing an override can
            // reveal its native Google route; disable it explicitly instead.
            editor.update(PROVIDER_ID, id, target => {
              target.enabled = false
              target.package = GOOGLE_PACKAGE
            })
            continue
          }
          editor.update(PROVIDER_ID, id, (target) => {
            // A native provider override can otherwise bypass the SDK hook.
            target.package = GOOGLE_PACKAGE
          })
        }
      }))

      registrations.push(await ctx.aisdk.hook("sdk", async (event) => {
        if (!ownsModel(event.model.id)) return
        if (accountCatalogLoaded && !modelDefinitions[event.model.id]) {
          throw new Error("This model is unavailable to the enabled Antigravity accounts. Refresh available models from /antigravity.")
        }
        if (event.package !== SDK_PACKAGE) return
        event.sdk = createGoogleGenerativeAI({
          ...event.options,
          fetch: scopedFetch(event.options.fetch, event.model.body),
          // SDK 3 checks for a nonempty key before invoking custom fetch. The
          // interceptor replaces this sentinel with account-specific OAuth.
          apiKey: event.options.apiKey ?? API_KEY_SENTINEL,
          baseURL: event.options.baseURL ?? "https://generativelanguage.googleapis.com/v1beta",
        })
      }, { providerID: PROVIDER_ID }))

      registrations.push(await ctx.tool.transform((editor) => {
        editor.add({
          name: "google_search",
          description: "Search Google for current information and analyze URLs. Include URLs from the question in the urls argument.",
          input: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1 },
              urls: { type: "array", items: { type: "string" } },
              thinking: { type: "boolean", default: true },
            },
            required: ["query"],
            additionalProperties: false,
          },
          async execute(input, context) {
            return runCredentialOperation(async () => {
              const signal = AbortSignal.any([context.signal, lifetime.signal, requestLifetime.signal])
              signal.throwIfAborted()
              const args = input as SearchArgs
              if (!args || typeof args.query !== "string" || !args.query.trim()) throw new Error("A search query is required")
              const resolved = await resolveAuth()
              let auth = resolved?.auth
              if (!auth) return { content: "Connect Google with Antigravity OAuth to use Google Search." }
              const metadata = resolved?.accountID ? { antigravityAccountId: resolved.accountID } : undefined
              if (!auth.access || accessTokenExpired(auth)) {
                const previous = oauthCredential(auth, metadata)
                auth = await refreshAccessToken(auth, client, PROVIDER_ID)
                if (auth) await rememberAuth(auth, undefined, previous)
              }
              if (!auth?.access) throw new Error("Antigravity token refresh failed; please sign in again")
              signal.throwIfAborted()
              const project = await ensureProjectContext(auth)
              if (project.auth.refresh !== auth.refresh) await rememberAuth(project.auth, undefined, oauthCredential(auth, metadata))
              signal.throwIfAborted()
              return { content: await executeSearch(args, auth.access, project.effectiveProjectId, signal) }
            })
          },
        })
      }))
      registrations.push(await registerAccountManagement(ctx, client, async () => {
        invalidateLoader()
        await transport.flush?.()
      }, refreshModels, async () => {
        hasSavedAccounts = (await loadAccounts())?.accounts.some(account => account.enabled !== false)
        if (hasSavedAccounts && ctx.options.discoverModels !== false) {
          try { await refreshModels() } catch (error) { log.warn("Model refresh unavailable", { error: String(error) }) }
        }
        await ctx.provider.reload()
      }, runCredentialOperation))
      if (hasSavedAccounts && ctx.options.discoverModels !== false && (!validCache || Date.now() - (cached?.updatedAt ?? 0) > 3600_000)) {
        try { await refreshModels() } catch (error) { log.warn("Model discovery unavailable; using cached or fallback models", { error: String(error) }) }
      }
      return cleanup
    } catch (error) {
      await cleanup()
      throw error
    }
  },
})

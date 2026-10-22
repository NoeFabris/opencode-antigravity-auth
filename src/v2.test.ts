import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter, on } from "node:events"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { Credential, Integration, Model, Provider, type Plugin } from "@opencode/plugin"
import type { ConnectionInfo, V2Event } from "@opencode/client"
import type { AISDKHooks } from "@opencode/plugin/promise/aisdk"
import type { IntegrationMethodRegistration } from "@opencode/plugin/promise/integration"
import type { ModelEditor } from "@opencode/plugin/promise/model"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import type { Info as ToolInfo, ToolContext } from "@opencode/plugin/promise/tool"
import type { DeepMutable } from "@opencode/plugin/promise/types"
import type { RpcHandlers } from "@opencode/plugin/promise/rpc"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"

import { AntigravityV2Plugin } from "./v2.ts"
import { AntigravityAccountsRpc } from "./plugin/account-rpc.ts"
import { accountID, accountPoolIdentity } from "./plugin/account-management.ts"
import { AccountManager } from "./plugin/accounts.ts"
import type { AvailableModel } from "./plugin/quota.ts"
import { createAntigravityPlugin } from "./plugin.ts"
import { ANTIGRAVITY_REDIRECT_URI } from "./constants.ts"
import { DEFAULT_CONFIG } from "./plugin/config/index.ts"
import type { AccountMetadataV3, AccountStorageV4 } from "./plugin/storage.ts"
import type { OAuthAuthDetails, PluginClient } from "./plugin/types.ts"

const state = vi.hoisted(() => ({
  storage: null as AccountStorageV4 | null,
  clear: vi.fn(),
  queueStart: vi.fn(),
  queueStop: vi.fn(),
  recovery: vi.fn(),
  updater: vi.fn(),
  closeListener: vi.fn(async () => undefined),
  callback: undefined as URL | undefined,
  exchange: vi.fn(),
  connectionStatus: vi.fn(async (_input: Parameters<Plugin.Context["integration"]["connection"]["status"]>[0]) => undefined),
}))

vi.mock("./plugin/storage.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./plugin/storage.ts")>()
  return {
    ...original,
    loadAccounts: vi.fn(async () => state.storage ? structuredClone(state.storage) : null),
    updateAccounts: vi.fn(async (update: (storage: AccountStorageV4) => void) => {
      const storage = structuredClone(state.storage ?? { version: 4 as const, accounts: [], activeIndex: 0 })
      update(storage)
      state.storage = storage
      return storage
    }),
    saveAccountCredentials: vi.fn(async (previous: AccountMetadataV3, updated: AccountMetadataV3) => {
      const storage = structuredClone(state.storage)
      const current = storage?.accounts.find(account => previous.id ? account.id === previous.id : account.refreshToken === previous.refreshToken)
      if (current?.refreshToken === previous.refreshToken) original.updateAccountCredentials(current, updated)
      state.storage = storage
      return storage
    }),
    saveAccounts: vi.fn(async (storage: AccountStorageV4) => {
      const accounts = new Map((state.storage?.accounts ?? []).map((account) => [account.refreshToken, account]))
      for (const account of storage.accounts) {
        if (account.id) for (const [token, previous] of accounts) if (previous.id === account.id && token !== account.refreshToken) accounts.delete(token)
        accounts.set(account.refreshToken, structuredClone(account))
      }
      const merged = original.deduplicateAccountsByEmail([...accounts.values()])
      const index = (value: number | undefined) => Math.max(0, merged.findIndex((account) => account.refreshToken === storage.accounts[value ?? storage.activeIndex]?.refreshToken))
      state.storage = { ...structuredClone(storage), accounts: merged, activeIndex: index(storage.activeIndex),
        activeIndexByFamily: { claude: index(storage.activeIndexByFamily?.claude), gemini: index(storage.activeIndexByFamily?.gemini) } }
    }),
    saveAccountsReplace: vi.fn(async (storage: AccountStorageV4) => { state.storage = structuredClone(storage) }),
    clearAccounts: state.clear,
  }
})
vi.mock("./plugin/config/index.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./plugin/config/index.ts")>(),
  loadConfig: () => ({ ...DEFAULT_CONFIG, proactive_token_refresh: true, request_jitter_max_ms: 0, quota_refresh_interval_minutes: 0 }),
}))
vi.mock("./plugin/version.ts", () => ({ refreshAntigravityVersion: async () => undefined, ANTIGRAVITY_VERSION_REFRESH_INTERVAL_MS: 10800000 }))
vi.mock("./plugin/project.ts", () => ({
  ensureProjectContext: async (auth: OAuthAuthDetails) => ({ auth, effectiveProjectId: "project" }),
  invalidateProjectContextCache: vi.fn(),
}))
vi.mock("./plugin/refresh-queue.ts", () => ({
  createProactiveRefreshQueue: () => ({ setAccountManager: vi.fn(), start: state.queueStart, stop: state.queueStop }),
}))
vi.mock("./plugin/recovery.ts", () => ({ createSessionRecoveryHook: state.recovery, getRecoverySuccessToast: vi.fn() }))
vi.mock("./hooks/auto-update-checker/index.ts", () => ({ createAutoUpdateCheckerHook: state.updater }))
vi.mock("./antigravity/oauth.ts", () => ({
  authorizeAntigravity: async () => ({ url: "https://accounts.google.com/auth?state=expected-state", verifier: "verifier", projectId: "project" }),
  exchangeAntigravity: state.exchange,
}))
vi.mock("./plugin/server.ts", () => ({
  startOAuthListener: async () => ({
    close: state.closeListener,
    waitForCallback: async () => state.callback ?? new URL(`${ANTIGRAVITY_REDIRECT_URI}?state=expected-state&code=callback-code`),
  }),
}))

type OAuthMethod = Extract<IntegrationMethodRegistration, { refresh?: unknown }>
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
const googleSDKPackage = `aisdk:${pathToFileURL(createRequire(import.meta.url).resolve("@ai-sdk/google")).href}`
const cleanups: Array<() => Promise<void> | void> = []

function credential(refresh = "refresh|project"): Credential.OAuth {
  return {
    type: "oauth",
    methodID: Integration.MethodID.make("antigravity"),
    refresh,
    access: "access-token",
    expires: Date.now() + 3600_000,
  }
}

function pool() {
  return {
    version: 4 as const,
    accounts: [{ refreshToken: "refresh", projectId: "project", email: "first@example.test", enabled: true, addedAt: 1, lastUsed: 1 }],
    activeIndex: 0,
  }
}

async function host(options: { value?: Credential.Value; connection?: boolean; nativeOverride?: boolean; catalog?: Record<string, AvailableModel>; catalogAccounts?: Record<string, string[]>; legacyOverride?: boolean; discoverModels?: boolean } = {}) {
  let value = options.value ?? credential()
  let connectionID: string | undefined
  let connected = options.connection !== false
  const provider = { ...Provider.Info.empty(Provider.ID.google), name: "Google", package: "@opencode/google" }
  const models = new Map<string, DeepMutable<Model.Info>>([
    ["gemini-native-only", Model.Info.default(Provider.ID.google, Model.ID.make("gemini-native-only")) as DeepMutable<Model.Info>],
  ])
  const record = { provider, models }
  const storage = new Map<string, unknown>()
  const events = new EventEmitter<{ event: [V2Event] }>()
  if (options.catalog) storage.set("model-catalog", { version: 3, identity: accountPoolIdentity(state.storage?.accounts ?? []), updatedAt: Date.now(), models: options.catalog, accounts: options.catalogAccounts ?? {} })
  let method: OAuthMethod | undefined
  let sdkHook: ((event: AISDKHooks["sdk"]) => Promise<void> | void) | undefined
  let modelTransform: ((editor: ModelEditor) => void) | undefined
  let tool: ToolInfo | undefined
  let accountHandlers: RpcHandlers<typeof AntigravityAccountsRpc> | undefined
  const disposals: ReturnType<typeof vi.fn>[] = []
  const registration = () => {
    const dispose = vi.fn(async () => undefined)
    disposals.push(dispose)
    return { dispose }
  }
  // Core applies AISDKNative.rewrite after each update callback, including
  // model transforms. Setting the ordinary Google SDK token cannot opt out.
  const nativeRewrite = (target: { package?: string }) => {
    if (target.package === "aisdk:@ai-sdk/google") target.package = "@opencode/ai/providers/google"
  }
  const updateModel: ProviderEditor["models"]["update"] = (_providerID, id, update) => {
    const model = models.get(id) ?? Model.Info.default(Provider.ID.google, Model.ID.make(id)) as DeepMutable<Model.Info>
    update(model)
    nativeRewrite(model)
    models.set(id, model)
  }
  const providerEditor = {
    get: () => record,
    update: (_id: string, update: (input: typeof provider) => void) => update(provider),
    models: { update: updateModel, remove: (_provider: string, id: string) => { models.delete(id) } },
  } as unknown as ProviderEditor
  const modelEditor = {
    list: () => [...models.values()],
    update: updateModel,
  } as unknown as ModelEditor
  const ctx = {
    options: { discoverModels: options.discoverModels ?? false },
    location: { directory: "/tmp/antigravity-v2-test" },
    storage: { get: vi.fn(async (key: string) => storage.get(key)), set: vi.fn(async (key: string, value: unknown) => { storage.set(key, value) }), remove: vi.fn(async (key: string) => { storage.delete(key) }) },
    credential: { activate: vi.fn(async ({ credentialID }: { credentialID: string }) => { connectionID = credentialID }) },
    event: {
      async *subscribe(options?: { signal?: AbortSignal }) {
        for await (const [event] of on(events, "event", options)) yield event as V2Event
      },
    },
    rpc: { register: async (_definition: typeof AntigravityAccountsRpc, handlers: RpcHandlers<typeof AntigravityAccountsRpc>) => {
      accountHandlers = handlers
      return registration()
    } },
    integration: {
      get: async () => ({ data: { connections: connectionID ? [{ type: "credential", id: connectionID, method: "oauth" }] : [] } }),
      connection: {
        active: async (): Promise<ConnectionInfo | undefined> => connected ? connectionID ? { type: "credential", id: Credential.ID.make(connectionID), method: "oauth", label: connectionID } : { type: "env", name: "test" } : undefined,
        resolve: async () => value,
        status: state.connectionStatus,
      },
      transform: async (callback: (editor: { method: { update(input: OAuthMethod): void } }) => void) => {
        callback({ method: { update: (input) => { method = input } } })
        return registration()
      },
    },
    provider: { reload: vi.fn(async () => undefined), transform: async (callback: (editor: ProviderEditor) => void) => { callback(providerEditor); return registration() } },
    model: {
      reload: vi.fn(async () => {
        // Core rebuilds from source definitions before applying transforms.
        models.set("gemini-native-only", Model.Info.default(Provider.ID.google, Model.ID.make("gemini-native-only")) as DeepMutable<Model.Info>)
        modelTransform?.(modelEditor)
      }),
      transform: async (callback: (editor: ModelEditor) => void) => {
        modelTransform = callback
        if (options.legacyOverride) models.set("antigravity-gemini-3-pro", { ...Model.Info.default(Provider.ID.google, Model.ID.make("antigravity-gemini-3-pro")), package: "@opencode/ai/providers/google" } as DeepMutable<Model.Info>)
        if (options.nativeOverride) for (const model of models.values()) model.package = "@opencode/google"
        callback(modelEditor)
        return registration()
      },
    },
    aisdk: {
      hook: async (_name: string, callback: typeof sdkHook, scope: { providerID: string }) => {
        expect(scope).toEqual({ providerID: "google" })
        sdkHook = callback
        return registration()
      },
    },
    tool: {
      transform: async (callback: (editor: { add(input: ToolInfo): void }) => void) => {
        callback({ add: (input) => { tool = input } })
        return registration()
      },
    },
  } as unknown as Plugin.Context
  const cleanup = await AntigravityV2Plugin.setup(ctx)
  if (cleanup) cleanups.push(cleanup)
  if (!method || !sdkHook || !tool || !cleanup) throw new Error("Missing V2 registrations")
  const hook = sdkHook
  return {
    models, provider, method, tool, cleanup, disposals, accountHandlers, storage, ctx,
    emit: (event: V2Event) => events.emit("event", event),
    setCredential: (next: Credential.Value, id?: string) => { value = next; connectionID = id },
    disconnect: () => { connected = false },
    async sdk(id = "antigravity-gemini-3-flash", settings: Record<string, unknown> = {}) {
      const model = models.get(id)
      if (!model) throw new Error("Missing model")
      const preparedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))
      const event: AISDKHooks["sdk"] = {
        model: model as unknown as Model.Info,
        package: model.package?.replace(/^aisdk:/, "") ?? "",
        options: { ...model.settings, ...settings, fetch: preparedFetch },
      }
      await hook(event)
      return { sdk: event.sdk as ReturnType<typeof import("@ai-sdk/google")["createGoogleGenerativeAI"]>, preparedFetch }
    },
  }
}

function mockNetwork() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "refreshed-access", expires_in: 3600 })
    return new Response(`data: ${JSON.stringify({ response: {
      candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Hello from Antigravity" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
    } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
  })
}

async function stream(sdk: ReturnType<typeof import("@ai-sdk/google")["createGoogleGenerativeAI"]>, id = "antigravity-gemini-3-flash", signal?: AbortSignal) {
  const response = await sdk(id).doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    abortSignal: signal,
  })
  const reader = response.stream.getReader()
  const parts: LanguageModelV3StreamPart[] = []
  while (true) {
    const item = await reader.read()
    if (item.done) return parts
    parts.push(item.value)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.storage = pool()
  state.callback = undefined
  state.exchange.mockResolvedValue({ type: "success", refresh: "new-refresh|project", access: "new-access", expires: 12345, projectId: "project", email: "second@example.test" })
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
})

describe("OpenCode V2 adapter", () => {
  it.each(["antigravity", "oauth"])("hides native API-key models when using %s OAuth", async methodID => {
    const adapter = await host({ value: { ...credential(), methodID: Integration.MethodID.make(methodID) } })
    expect(adapter.models.get("gemini-native-only")?.enabled).toBe(false)
    expect(adapter.models.get("antigravity-gemini-3-flash")?.enabled).toBe(true)
  })

  it("preserves native models for another plugin's OAuth connection", async () => {
    const adapter = await host({ value: { ...credential(), methodID: Integration.MethodID.make("other-google-oauth") } })
    expect(adapter.models.get("gemini-native-only")?.enabled).toBe(true)
  })

  it("preserves native models for an unrelated migrated OAuth credential", async () => {
    const adapter = await host({ value: { ...credential("unrelated|project"), methodID: Integration.MethodID.make("oauth") } })
    expect(adapter.models.get("gemini-native-only")?.enabled).toBe(true)
  })

  it("keeps native API-key models hidden when the Antigravity pool is disabled", async () => {
    state.storage!.accounts[0]!.enabled = false
    const adapter = await host()
    expect(adapter.models.get("gemini-native-only")?.enabled).toBe(false)
  })

  it("updates native model availability when switching between OAuth and an API key", async () => {
    const adapter = await host()
    adapter.setCredential({ type: "key", key: "real-key" }, "native-key")
    adapter.emit({ type: "credential.switched", id: "event-key", created: Date.now(), data: { integrationID: "google", credentialID: "native-key" } } as V2Event)
    await vi.waitFor(() => expect(adapter.ctx.model.reload).toHaveBeenCalledTimes(1))
    expect(adapter.models.get("gemini-native-only")?.enabled).toBe(true)

    adapter.setCredential(credential(), "native-oauth")
    adapter.emit({ type: "credential.switched", id: "event-oauth", created: Date.now(), data: { integrationID: "google", credentialID: "native-oauth" } } as V2Event)
    await vi.waitFor(() => expect(adapter.ctx.model.reload).toHaveBeenCalledTimes(2))
    expect(adapter.models.get("gemini-native-only")?.enabled).toBe(false)
  })

  it.each(["credential.updated", "integration.updated"] as const)("updates the model catalog after %s and stops listening on cleanup", async type => {
    const adapter = await host({ value: { type: "key", key: "real-key" } })
    adapter.setCredential(credential())
    adapter.emit({ type, id: "event-update", created: Date.now(), data: {} } as V2Event)
    await vi.waitFor(() => expect(adapter.models.get("gemini-native-only")?.enabled).toBe(false))
    await adapter.cleanup()
    expect(adapter.emit({ type, id: "event-after-cleanup", created: Date.now(), data: {} } as V2Event)).toBe(false)
  })

  it.each([true, false])("retries a failed model reload on the next credential event (initial OAuth=%s)", async initiallyOAuth => {
    const key = { type: "key", key: "real-key" } as const
    const adapter = await host({ value: initiallyOAuth ? credential() : key })
    vi.mocked(adapter.ctx.model.reload).mockRejectedValueOnce(new Error("Temporary catalog reload failure"))
    adapter.setCredential(initiallyOAuth ? key : credential())
    adapter.emit({ type: "credential.updated", id: "event-first", created: Date.now(), data: {} } as V2Event)
    await vi.waitFor(() => expect(adapter.ctx.model.reload).toHaveBeenCalledTimes(1))
    expect(adapter.models.get("gemini-native-only")?.enabled).toBe(!initiallyOAuth)

    adapter.emit({ type: "credential.updated", id: "event-retry", created: Date.now(), data: {} } as V2Event)
    await vi.waitFor(() => expect(adapter.ctx.model.reload).toHaveBeenCalledTimes(2))
    expect(adapter.models.get("gemini-native-only")?.enabled).toBe(initiallyOAuth)
  })

  it("keeps native selection when an unrelated account is disabled before inference", async () => {
    mockNetwork()
    state.storage!.accounts.push({ ...pool().accounts[0]!, email: "second@example.test", refreshToken: "second" })
    state.storage!.accounts.push({ ...pool().accounts[0]!, email: "third@example.test", refreshToken: "third" })
    const adapter = await host()
    adapter.setCredential(credential("second|project"), "native-second")
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    await adapter.accountHandlers!.update({ id: accountID(state.storage!.accounts[2]!), action: "disable" }, context)
    const { sdk } = await adapter.sdk()
    await stream(sdk)
    expect(state.storage!.accounts[state.storage!.activeIndex]?.refreshToken).toBe("second")
  })

  it("respects native switches away from and back to an account selected through the menu", async () => {
    mockNetwork()
    state.storage!.accounts.push({ ...pool().accounts[0]!, email: "second@example.test", refreshToken: "second" })
    const adapter = await host()
    adapter.setCredential(credential("second|project"), "native-second")
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    await adapter.accountHandlers!.update({ id: accountID(state.storage!.accounts[1]!), action: "select" }, context)
    const { sdk } = await adapter.sdk()
    await stream(sdk)
    expect(state.storage!.accounts[state.storage!.activeIndex]?.refreshToken).toBe("second")
    adapter.setCredential(credential(), "native-first")
    await stream(sdk)
    expect(state.storage!.accounts[state.storage!.activeIndex]?.refreshToken).toBe("refresh")
    adapter.setCredential(credential("second|project"), "native-second")
    await stream(sdk)
    expect(state.storage!.accounts[state.storage!.activeIndex]?.refreshToken).toBe("second")
  })

  it("persists discovery's rotated credentials and project fields before caching the catalog", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 })
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: { "gemini-3.8-flash-high": {} } })
      return Response.json({ buckets: [] })
    })
    const id = accountID(state.storage!.accounts[0]!)
    const adapter = await host({ discoverModels: true, connection: false })
    expect(state.storage?.accounts[0]).toMatchObject({ id, refreshToken: "rotated" })
    expect(adapter.storage.get("model-catalog")).toMatchObject({ version: 3, identity: accountPoolIdentity(state.storage!.accounts), accounts: { "antigravity-gemini-3.8-flash-high": [id] } })
  })

  it("sends a discovered model only through an account advertising it", async () => {
    const network = mockNetwork()
    state.storage!.accounts.push({ ...pool().accounts[0]!, email: "second@example.test", refreshToken: "second" })
    const adapter = await host({ connection: false, catalog: { "gemini-3.8-flash-high": {} }, catalogAccounts: { "antigravity-gemini-3.8-flash-high": [accountID(state.storage!.accounts[1]!)] } })
    const { sdk } = await adapter.sdk("antigravity-gemini-3.8-flash-high")
    await stream(sdk, "antigravity-gemini-3.8-flash-high")
    const tokenRequests = network.mock.calls.filter(([input]) => String(input).includes("oauth2.googleapis.com/token"))
    expect(tokenRequests).toHaveLength(1)
    expect(String(tokenRequests[0]?.[1]?.body)).toContain("refresh_token=second")
  })

  it("disables retired models from legacy config instead of exposing a native Google route", async () => {
    const adapter = await host({ catalog: { "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)", maxTokens: 1048576, maxOutputTokens: 65536 } }, legacyOverride: true })
    expect(adapter.models.get("antigravity-gemini-3-pro")?.enabled).toBe(false)
    expect(adapter.models.get("gemini-native-only")?.enabled).toBe(false)
    await expect(adapter.sdk("antigravity-gemini-3-pro")).rejects.toThrow("unavailable to the enabled Antigravity accounts")
  })

  it("keeps its SDK route after Core rewrites standard Google packages following every transform", async () => {
    const adapter = await host({ nativeOverride: true })
    for (const [id, model] of adapter.models) {
      if (!id.startsWith("antigravity-")) continue
      expect(model.package).toBe(googleSDKPackage)
      expect(model.package).toMatch(/^aisdk:file:\/\//)
    }
    expect(adapter.provider.package).toBe("@opencode/google")
    expect(adapter.models.get("gemini-native-only")?.package).toBe("@opencode/google")
  })

  it("streams a real SDK 3 request through the existing interceptor and preserves the prepared fetch", async () => {
    const network = mockNetwork()
    const adapter = await host({ nativeOverride: true })
    const { sdk, preparedFetch } = await adapter.sdk()
    const parts = await stream(sdk)
    expect(parts).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "Hello from Antigravity" }))
    expect(parts).toContainEqual(expect.objectContaining({ type: "finish", finishReason: { unified: "stop", raw: "STOP" } }))
    expect(preparedFetch).toHaveBeenCalledOnce()
    const call = network.mock.calls.find(([input]) => (input instanceof Request ? input.url : String(input)).includes("streamGenerateContent"))
    expect(call).toBeDefined()
    const [input, init] = call!
    const request = new Request(input, init)
    expect(request.url).toContain("/v1internal:streamGenerateContent")
    expect(request.url).not.toContain("generativelanguage.googleapis.com")
    const headers = request.headers
    expect(headers.get("authorization")).toBe("Bearer access-token")
    expect(headers.has("x-goog-api-key")).toBe(false)
    const body = await request.text()
    expect(body).not.toContain("antigravity-oauth")
    expect(JSON.parse(body)).toMatchObject({ project: "project", model: "gemini-3-flash", request: { contents: expect.any(Array) } })
  })

  it("only changes owned models and leaves native Google API-key access available", async () => {
    const adapter = await host({ value: { type: "key", key: "real-key" } })
    expect(adapter.provider.package).toBe("@opencode/google")
    expect(adapter.models.get("gemini-native-only")?.package).toBeUndefined()
    expect(adapter.models.get("gemini-native-only")?.enabled).toBe(true)
    expect(adapter.models.get("antigravity-gemini-3-flash")?.package).toBe(googleSDKPackage)
    expect(adapter.models.has("gemini-2.5-flash")).toBe(false)
    const { sdk } = await adapter.sdk("gemini-native-only", { apiKey: "real-key", baseURL: "https://custom.example.test" })
    expect(sdk).toBeUndefined()
    expect(state.clear).not.toHaveBeenCalled()
  })

  it("uses enabled saved accounts without a V2 connection and preserves the pool on disconnect", async () => {
    mockNetwork()
    state.storage!.accounts.unshift({ ...pool().accounts[0]!, refreshToken: "disabled", email: "disabled@example.test", enabled: false })
    const adapter = await host({ connection: false })
    expect(adapter.provider.activation).toBe("enabled")
    const { sdk } = await adapter.sdk()
    expect(await stream(sdk)).toContainEqual(expect.objectContaining({ type: "text-delta" }))
    expect(state.storage?.accounts).toHaveLength(2)
    expect(state.clear).not.toHaveBeenCalled()
  })

  it("recognizes a migrated V1 OAuth credential only when its token belongs to the saved pool", async () => {
    const network = mockNetwork()
    const adapter = await host({ value: { ...credential(), methodID: Integration.MethodID.make("oauth") } })
    const { sdk } = await adapter.sdk()
    expect(await stream(sdk)).toContainEqual(expect.objectContaining({ type: "text-delta" }))
    expect(network.mock.calls.some(([input]) => (input instanceof Request ? input.url : String(input)).includes("daily-cloudcode"))).toBe(true)
    adapter.setCredential({ ...credential("unrelated|project"), methodID: Integration.MethodID.make("oauth") })
    await expect(stream(sdk)).rejects.toThrow("Connect Google with Antigravity OAuth")
  })

  it("keeps the pool loader stable when rotation changes the saved active account", async () => {
    mockNetwork()
    state.storage!.accounts.push({ ...pool().accounts[0]!, refreshToken: "other" })
    const adapter = await host({ connection: false })
    const { sdk } = await adapter.sdk()
    await stream(sdk)
    state.storage!.activeIndex = 1
    await stream(sdk)
    expect(state.queueStart).toHaveBeenCalledOnce()
  })

  it("uses a cached SDK after an account is added to an initially empty pool", async () => {
    mockNetwork()
    state.storage = null
    const adapter = await host({ connection: false })
    const { sdk } = await adapter.sdk()
    state.storage = pool()
    expect(await stream(sdk)).toContainEqual(expect.objectContaining({ type: "text-delta" }))
  })

  it("allows Core resolution after revocation so the transport rotates to a healthy account", async () => {
    state.storage!.accounts.push({ ...pool().accounts[0]!, refreshToken: "healthy", email: "healthy@example.test" })
    const original = mockNetwork().getMockImplementation()!
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("oauth2.googleapis.com") && String(init?.body).includes("refresh_token=refresh&")) {
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      }
      return original(input, init)
    })
    const adapter = await host()
    adapter.setCredential(credential(), "native-first")
    adapter.storage.set("connection-account:native-first", accountID(state.storage!.accounts[0]!))
    const refreshed = await adapter.method.refresh!(credential())
    expect(refreshed.access).toBe("")
    expect(refreshed.expires).toBeGreaterThan(Date.now() + 5 * 60_000)
    expect(state.connectionStatus).toHaveBeenCalledWith(expect.objectContaining({ status: expect.objectContaining({ status: "needs_auth" }) }))
    expect(state.storage!.accounts[0]!.enabled).toBe(false)
    adapter.setCredential(refreshed, "native-first")
    const { sdk } = await adapter.sdk()
    expect(await stream(sdk)).toContainEqual(expect.objectContaining({ type: "text-delta" }))
    expect(state.storage!.activeIndexByFamily?.gemini).toBe(1)
  })

  it("keeps an account enabled after a temporary refresh failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Temporary network failure"))
    const adapter = await host()
    const refreshed = await adapter.method.refresh!(credential())
    expect(refreshed.access).toBe("")
    expect(state.storage!.accounts[0]!.enabled).toBe(true)
    expect(state.connectionStatus).not.toHaveBeenCalled()
  })

  it("returns V2 OAuth credentials, rejects invalid callback state and keeps multiple accounts", async () => {
    const adapter = await host()
    const auth = await adapter.method.authorize({ manual: true })
    if (auth.mode !== "code") throw new Error("Expected manual OAuth")
    await expect(auth.callback(`${ANTIGRAVITY_REDIRECT_URI}?code=code&state=wrong`)).rejects.toThrow("state")
    await expect(auth.callback("https://malicious.test/?code=code&state=expected-state")).rejects.toThrow("callback")
    expect(state.exchange).not.toHaveBeenCalled()
    const result = await auth.callback("manual-code")
    expect(result).toEqual({ type: "oauth", methodID: "antigravity", refresh: "new-refresh|project", access: "new-access", expires: 12345, metadata: { email: "second@example.test", antigravityAccountId: accountID({ refreshToken: "new-refresh" }) } })
    expect(state.exchange).toHaveBeenCalledWith("manual-code", "expected-state")
    expect(state.storage?.accounts.map((account) => account.refreshToken)).toEqual(["refresh", "new-refresh"])
    const automatic = await adapter.method.authorize({ manual: false })
    if (automatic.mode !== "auto") throw new Error("Expected automatic OAuth")
    await expect(automatic.callback).resolves.toMatchObject({ type: "oauth", methodID: "antigravity" })
    expect(state.closeListener).toHaveBeenCalledOnce()
  })

  it("drains automatic OAuth listener startup and closes a listener acquired after disposal", async () => {
    const server = await import("./plugin/server.ts")
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let rejectCallback!: (reason: Error) => void
    const callback = new Promise<URL>((_resolve, reject) => { rejectCallback = reject })
    let bound = false
    const close = vi.fn(async () => { bound = false; rejectCallback(new Error("Listener closed")) })
    vi.spyOn(server, "startOAuthListener").mockImplementationOnce(async () => {
      announce()
      await gate
      bound = true
      return { waitForCallback: () => callback, close }
    })
    const adapter = await host({ connection: false })
    const authorizing = adapter.method.authorize({ manual: false }).catch(error => error)
    await started
    let cleaned = false
    const cleanup = adapter.cleanup()
    expect(adapter.cleanup()).toBe(cleanup)
    void Promise.resolve(cleanup).then(() => { cleaned = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(cleaned).toBe(false)
    } finally { release() }
    await expect(authorizing).resolves.toBeInstanceOf(Error)
    await cleanup
    expect(close).toHaveBeenCalled()
    expect(bound).toBe(false)
    const replacement = await host({ connection: false })
    const authorization = await replacement.method.authorize({ manual: false })
    if (authorization.mode !== "auto") throw new Error("Expected automatic OAuth")
    await expect(authorization.callback).resolves.toMatchObject({ type: "oauth" })
  })

  it("refreshes the V2 credential shape and merges rotated tokens by account identity", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: "refreshed", refresh_token: "rotated", expires_in: 3600 }))
    const adapter = await host()
    const result = await adapter.method.refresh!(credential())
    expect(result).toMatchObject({ type: "oauth", methodID: "antigravity", refresh: "rotated|project", access: "refreshed" })
    expect(result.expires).toBeGreaterThan(Date.now())
    expect(String(network.mock.calls[0]?.[1]?.body)).toContain("refresh_token=refresh")
    expect(state.storage?.accounts).toHaveLength(1)
    expect(state.storage?.accounts[0]?.refreshToken).toBe("rotated")
  })

  it("rebuilds transport on credential changes and disposes refresh queues and registrations", async () => {
    mockNetwork()
    const adapter = await host()
    const { sdk } = await adapter.sdk()
    await stream(sdk)
    adapter.setCredential(credential("second|project"))
    await stream(sdk)
    expect(state.queueStart).toHaveBeenCalledTimes(2)
    expect(state.queueStop).toHaveBeenCalledOnce()
    expect(state.storage?.accounts).toHaveLength(2)
    expect(state.storage!.accounts[state.storage!.activeIndex]?.refreshToken).toBe("second")
    await adapter.cleanup()
    expect(state.queueStop).toHaveBeenCalledTimes(2)
    expect(adapter.disposals).toHaveLength(6)
    for (const dispose of adapter.disposals) expect(dispose).toHaveBeenCalledOnce()
    await expect(stream(sdk)).rejects.toThrow("disposed")
    expect(state.recovery).not.toHaveBeenCalled()
    expect(state.updater).not.toHaveBeenCalled()
  })

  it("retains cancellation through the prepared wrapper and aborts in-flight requests on cleanup", async () => {
    const adapter = await host()
    const { sdk } = await adapter.sdk()
    const network = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) reject(signal.reason)
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    }))
    const request = stream(sdk)
    const rejection = expect(request).rejects.toThrow("disposed")
    await vi.waitFor(() => expect(network).toHaveBeenCalled())
    await adapter.cleanup()
    await rejection
  })

  it("registers google_search with a JSON schema and V2 content result", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ response: { candidates: [{ content: { parts: [{ text: "Search answer" }] } }] } }))
    const adapter = await host()
    expect(adapter.tool.input).toMatchObject({ type: "object", required: ["query"] })
    const result = await adapter.tool.execute({ query: "latest", urls: ["https://example.test"] }, { signal: new AbortController().signal } as ToolContext)
    expect(result.content).toContain("Search answer")
    expect(String(network.mock.calls[0]?.[0])).toContain(":generateContent")
  })

  it("does not clear saved accounts when the shared loader sees no V2 OAuth", async () => {
    const noop = async () => undefined
    const client: PluginClient = { auth: { set: noop }, app: { log: noop }, tui: { showToast: noop }, session: { prompt: noop, abort: noop, messages: noop } }
    const plugin = await createAntigravityPlugin("google")({ client, directory: "/tmp/antigravity-v2-test", runtimeVersion: 2 })
    expect(await plugin.auth.loader(async () => ({ type: "none" }), {})).toEqual({})
    expect(state.clear).not.toHaveBeenCalled()
    await plugin.dispose?.()
  })
})

describe("discovery and account eligibility regressions", () => {
  it("preserves rotated tokens even when catalog retrieval fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 })
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ error: "temporary catalog outage" }, { status: 503 })
      return Response.json({ buckets: [] })
    })
    await host({ discoverModels: true, connection: false })
    expect(state.storage?.accounts[0]?.refreshToken).toBe("rotated")
  })

  it("does not overwrite discovery rotation when retiring the existing manager", async () => {
    state.storage!.accounts[0]!.refreshToken = "before-discovery"
    let discovering = false
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fresh", ...(discovering ? { refresh_token: "rotated" } : {}), expires_in: 3600 })
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: { "gemini-3-flash": {} } })
      if (url.endsWith(":retrieveUserQuota")) return Response.json({ buckets: [] })
      return new Response(`data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    })
    const adapter = await host({ connection: false })
    const { sdk } = await adapter.sdk()
    await stream(sdk)
    discovering = true
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    await adapter.accountHandlers!.models({}, context)
    expect(state.storage?.accounts[0]?.refreshToken).toBe("rotated")
  })

  it("keeps a quota refresh rotation when an existing manager later saves", async () => {
    state.storage!.accounts[0]!.refreshToken = "before-quota"
    let checkingQuota = false
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fresh", ...(checkingQuota ? { refresh_token: "quota-rotated" } : {}), expires_in: 3600 })
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: { "gemini-3-flash": {} } })
      if (url.endsWith(":retrieveUserQuota")) return Response.json({ buckets: [] })
      return new Response(`data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    })
    const adapter = await host({ connection: false })
    const { sdk } = await adapter.sdk()
    await stream(sdk)
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    const id = accountID(state.storage!.accounts[0]!)
    checkingQuota = true
    await adapter.accountHandlers!.quotas({ id }, context)
    expect(state.storage?.accounts[0]?.refreshToken).toBe("quota-rotated")
    await adapter.accountHandlers!.connections({ id }, context)
    expect(state.storage?.accounts[0]?.refreshToken).toBe("quota-rotated")
  })

  it("does not rotate toward an ineligible account instead of falling back to CLI", async () => {
    const network = mockNetwork()
    state.storage!.accounts[0]!.refreshToken = "gemini-ineligible"
    state.storage!.accounts.push({ ...pool().accounts[0]!, email: "gemini-eligible@example.test", refreshToken: "gemini-eligible", rateLimitResetTimes: { "gemini-antigravity": Date.now() + 3600_000 } })
    const id = "antigravity-gemini-3.8-flash-high"
    const adapter = await host({ connection: false, catalog: { "gemini-3.8-flash-high": {} }, catalogAccounts: { [id]: [accountID(state.storage!.accounts[1]!)] } })
    const { sdk } = await adapter.sdk(id)
    const controller = new AbortController()
    const original = AccountManager.prototype.hasOtherAccountWithAntigravityAvailable
    let checks = 0
    vi.spyOn(AccountManager.prototype, "hasOtherAccountWithAntigravityAvailable").mockImplementation(function (this: AccountManager, ...args) {
      const result = original.apply(this, args)
      if (++checks >= 3) controller.abort(new Error("bounded after three rotation checks"))
      return result
    })
    await stream(sdk, id, controller.signal).catch(() => [])
    expect(checks).toBeLessThanOrEqual(1)
    expect(network.mock.calls.some(([input]) => (input instanceof Request ? input.url : String(input)).includes(":streamGenerateContent"))).toBe(true)
  })

  it("blocks a cached SDK after the only account supporting its model is disabled", async () => {
    const model = "antigravity-gemini-3.8-flash-high"
    state.storage!.accounts[0]!.refreshToken = "only-low"
    state.storage!.accounts.push({ ...pool().accounts[0]!, email: "high@example.test", refreshToken: "only-high" })
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: `access-${new URLSearchParams(String(init?.body)).get("refresh_token")}`, expires_in: 3600 })
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: { "gemini-3.8-flash-low": {} } })
      if (url.endsWith(":retrieveUserQuota")) return Response.json({ buckets: [] })
      return new Response(`data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    })
    const highAccount = accountID(state.storage!.accounts[1]!)
    const adapter = await host({ connection: false, discoverModels: true, catalog: { "gemini-3.8-flash-high": {}, "gemini-3.8-flash-low": {} }, catalogAccounts: { [model]: [highAccount], "antigravity-gemini-3.8-flash-low": [accountID(state.storage!.accounts[0]!)] } })
    const { sdk } = await adapter.sdk(model)
    await stream(sdk, model)
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    await adapter.accountHandlers!.update({ id: highAccount, action: "disable" }, context)
    expect(adapter.storage.get("model-catalog")).toMatchObject({ accounts: { "antigravity-gemini-3.8-flash-low": [accountID(state.storage!.accounts[0]!)] } })
    network.mockClear()
    await expect(stream(sdk, model)).rejects.toThrow(/unavailable|access/)
  })

  it("enforces the max wait using only accounts eligible for this model", async () => {
    mockNetwork()
    state.storage!.accounts.push({ ...pool().accounts[0]!, email: "eligible@example.test", refreshToken: "eligible", rateLimitResetTimes: { claude: Date.now() + 10 * 3600_000 } })
    const id = "antigravity-claude-sonnet-5-5-high"
    const adapter = await host({ connection: false, catalog: { "claude-sonnet-5-5-high": {} }, catalogAccounts: { [id]: [accountID(state.storage!.accounts[1]!)] } })
    const { sdk } = await adapter.sdk(id)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("test deadline reached")), 1000)
    try {
      await expect(stream(sdk, id, controller.signal)).rejects.toThrow(/rate-limited.*claude|Quota resets in/)
    } finally { clearTimeout(timer) }
  })
})

describe("account lifecycle regressions", () => {
  it("does not resurrect disabled accounts from a loader still being constructed", async () => {
    mockNetwork()
    state.storage!.accounts.push({ ...pool().accounts[0]!, email: "second@example.test", refreshToken: "second" })
    const adapter = await host()
    const { sdk } = await adapter.sdk()
    const { AccountManager } = await import("./plugin/accounts.ts")
    const originalLoad = AccountManager.loadFromDisk
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let finish!: () => void
    const pause = new Promise<void>(resolve => { finish = resolve })
    vi.spyOn(AccountManager, "loadFromDisk").mockImplementationOnce(async auth => {
      const manager = await originalLoad(auth)
      announce()
      await pause
      return manager
    })
    const request = stream(sdk)
    await started
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    await adapter.accountHandlers!.update({ id: accountID(state.storage!.accounts[0]!), action: "disable" }, context)
    expect(state.storage!.accounts[0]!.enabled).toBe(false)
    finish()
    await request
    expect(state.storage!.accounts[0]!.enabled).toBe(false)
  })

  it("preserves stable identity when native rotation refreshes an account without email", async () => {
    delete (state.storage!.accounts[0]! as { email?: string }).email
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: "refreshed", refresh_token: "rotated-no-email", expires_in: 3600 }))
    const adapter = await host()
    const id = state.storage!.accounts[0]!.id
    const result = await adapter.method.refresh!(credential())
    expect(result.refresh).toContain("rotated-no-email")
    expect(state.storage!.accounts).toHaveLength(1)
    expect(state.storage!.accounts[0]).toMatchObject({ id, refreshToken: "rotated-no-email" })
  })

  it("preserves native rotation when an old loaded manager still has a pending save", async () => {
    const network = mockNetwork()
    const adapter = await host()
    const { sdk } = await adapter.sdk()
    await stream(sdk)
    const id = state.storage!.accounts[0]!.id
    network.mockImplementationOnce(async () => Response.json({ access_token: "refreshed", refresh_token: "rotated-loaded", expires_in: 3600 }))
    const result = await adapter.method.refresh!(credential())
    expect(state.storage!.accounts[0]).toMatchObject({ id, refreshToken: "rotated-loaded" })
    adapter.setCredential(result)
    await stream(sdk)
    expect(state.storage!.accounts).toHaveLength(1)
    expect(state.storage!.accounts[0]).toMatchObject({ id, refreshToken: "rotated-loaded" })
  })
})


describe("quota credential regressions", () => {
  it("retains a rotated token when the inventory request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fresh", refresh_token: "rotated-failed-discovery", expires_in: 3600 })
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 })
      return Response.json({ buckets: [] })
    })
    const adapter = await host({ discoverModels: true, connection: false })
    const storage = await import("./plugin/storage.ts")
    const latest = await storage.loadAccounts()
    expect(latest!.accounts).toHaveLength(1)
    expect(latest!.accounts[0]!.refreshToken).toBe("rotated-failed-discovery")
  })

  it("keeps quota-refreshed credentials when the active manager is retired", async () => {
    const network = mockNetwork()
    const adapter = await host({ connection: false })
    const { sdk } = await adapter.sdk()
    await stream(sdk)
    network.mockImplementation(async input => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fresh", refresh_token: "rotated-quota", expires_in: 3600 })
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: { "gemini-3-flash": {} } })
      return Response.json({ buckets: [] })
    })
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    await adapter.accountHandlers!.quotas({}, context)
    const storage = await import("./plugin/storage.ts")
    expect((await storage.loadAccounts())!.accounts[0]!.refreshToken).toBe("rotated-quota")
    await adapter.cleanup()
    expect((await storage.loadAccounts())!.accounts[0]!.refreshToken).toBe("rotated-quota")
  })
})

describe("independent overlap review", () => {
  it("does not re-add an account deleted before the resolved auth reaches pool membership lookup", async () => {
    mockNetwork()
    delete state.storage!.accounts[0]!.email
    state.storage!.accounts.push({ ...pool().accounts[0]!, email: "survivor@example.test", refreshToken: "survivor" })
    const adapter = await host({ connection: false })
    const deletedID = accountID(state.storage!.accounts[0]!)
    const { sdk } = await adapter.sdk()
    const storageModule = await import("./plugin/storage.ts")
    const load = vi.spyOn(storageModule, "loadAccounts")
    let loads = 0
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let finish!: () => void
    const pause = new Promise<void>(resolve => { finish = resolve })
    load.mockImplementation(async () => {
      if (++loads === 3) { announce(); await pause }
      return state.storage ? structuredClone(state.storage) : null
    })
    const request = stream(sdk)
    await started
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    await adapter.accountHandlers!.update({ id: deletedID, action: "delete" }, context)
    expect(state.storage!.accounts.map(accountID)).not.toContain(deletedID)
    finish()
    await request
    const disk = await (await import("./plugin/storage.ts")).loadAccounts()
    expect(disk!.accounts.map(accountID)).not.toContain(deletedID)
    expect(disk!.accounts.map(account => account.refreshToken)).toEqual(["survivor"])
  })

  it("does not add an obsolete no-email token if quota rotates while the resolved auth reaches pool lookup", async () => {
    mockNetwork()
    delete state.storage!.accounts[0]!.email
    const adapter = await host({ connection: false })
    const originalID = accountID(state.storage!.accounts[0]!)
    const { sdk } = await adapter.sdk()
    const storageModule = await import("./plugin/storage.ts")
    const load = vi.spyOn(storageModule, "loadAccounts")
    let loads = 0
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let finish!: () => void
    const pause = new Promise<void>(resolve => { finish = resolve })
    load.mockImplementation(async () => {
      if (++loads === 3) { announce(); await pause }
      return state.storage ? structuredClone(state.storage) : null
    })
    const request = stream(sdk)
    await started
    await storageModule.updateAccounts(pool => { pool.accounts[0]!.refreshToken = "externally-rotated" })
    finish()
    await request
    const disk = await (await import("./plugin/storage.ts")).loadAccounts()
    expect(disk!.accounts).toHaveLength(1)
    expect(disk!.accounts[0]).toMatchObject({ id: originalID, refreshToken: "externally-rotated" })
  })

  it("stops any queue constructed while cleanup waits for initial managed persistence", async () => {
    mockNetwork()
    const adapter = await host({ connection: false })
    const { sdk } = await adapter.sdk()
    const storageModule = await import("./plugin/storage.ts")
    const original = vi.mocked(storageModule.updateAccounts).getMockImplementation()!
    const update = vi.spyOn(storageModule, "updateAccounts")
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let finish!: () => void
    const pause = new Promise<void>(resolve => { finish = resolve })
    update.mockImplementationOnce(async callback => { announce(); await pause; return original(callback) })
    const request = stream(sdk).then(() => undefined, error => error)
    await started
    let cleaned = false
    const cleanup = Promise.resolve(adapter.cleanup()).then(() => { cleaned = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(cleaned).toBe(false)
    } finally { finish() }
    await cleanup
    expect(await request).toBeInstanceOf(Error)
    expect(adapter.disposals.every(dispose => dispose.mock.calls.length > 0)).toBe(true)
    expect(state.queueStop.mock.calls.length).toBeGreaterThanOrEqual(state.queueStart.mock.calls.length)
  })
})


describe("native binding review", () => {
  it("maps an existing native connection after quota rotates its pool refresh token", async () => {
    const network = mockNetwork()
    delete state.storage!.accounts[0]!.email
    const adapter = await host()
    adapter.setCredential(credential(), "native-original")
    const { sdk } = await adapter.sdk()
    await stream(sdk)
    const id = accountID(state.storage!.accounts[0]!)
    expect(adapter.storage.get("connection-account:native-original")).toBe(id)
    network.mockImplementation(async input => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fresh", refresh_token: "rotated-by-quota", expires_in: 3600 })
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: { "gemini-3-flash": {} } })
      return Response.json({ buckets: [] })
    })
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    await adapter.accountHandlers!.quotas({ id }, context)
    expect(state.storage!.accounts[0]!.refreshToken).toBe("rotated-by-quota")
    expect(await adapter.accountHandlers!.connections({ id }, context)).toEqual({ ids: ["native-original"] })
  })
})

describe("independent integration edge cases", () => {
  it("creates a saved pool entry on first native OAuth login with no storage file", async () => {
    const realStorage = await import("./plugin/storage.ts")
    state.storage = null
    const adapter = await host({ connection: false })
    const authorization = await adapter.method.authorize({ manual: true, projectId: "project" })
    if (authorization.mode !== "code") throw new Error("Expected manual auth")
    const result = await authorization.callback("first-login-code")
    expect(result.type).toBe("oauth")
    const actual = await realStorage.loadAccounts()
    expect(actual?.accounts).toHaveLength(1)
  })

  it("can stream after first native OAuth login with no storage file", async () => {
    const realStorage = await import("./plugin/storage.ts")
    state.storage = null
    mockNetwork()
    const adapter = await host()
    const authorization = await adapter.method.authorize({ manual: true, projectId: "project" })
    if (authorization.mode !== "code") throw new Error("Expected manual auth")
    const result = await authorization.callback("first-login-code")
    adapter.setCredential(result, "first-native")
    const { sdk } = await adapter.sdk()
    await expect(stream(sdk)).resolves.toContainEqual(expect.objectContaining({ type: "text-delta" }))
  })

  it("retains a discovery rotation when the account is disabled while catalog I/O is pending", async () => {
    const adapter = await host({ connection: false })
    const realStorage = await import("./plugin/storage.ts")
    const id = (await realStorage.loadAccounts())!.accounts[0]!.id!
    let started!: () => void
    const catalogStarted = new Promise<void>(resolve => { started = resolve })
    let release!: () => void
    const catalogGate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fresh", refresh_token: "rotated-while-disabled", expires_in: 3600 })
      if (url.endsWith(":fetchAvailableModels")) {
        started()
        await catalogGate
        return Response.json({ models: { "gemini-3-flash": {} } })
      }
      return Response.json({ buckets: [] })
    })
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    const refresh = adapter.accountHandlers!.models({}, context)
    await catalogStarted
    await adapter.accountHandlers!.update({ id, action: "disable" }, context)
    release()
    await refresh
    const actual = await realStorage.loadAccounts()
    expect(actual?.accounts[0]).toMatchObject({ id, enabled: false, refreshToken: "rotated-while-disabled" })
  })
})



describe("native connection bindings", () => {
  it("maps an inactive migrated native connection after discovery rotates its pool token", async () => {
    state.storage!.accounts.push({ refreshToken: "second", projectId: "project", enabled: true, addedAt: 1, lastUsed: 1 })
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) {
        const token = new URLSearchParams(String(init?.body)).get("refresh_token")!
        return Response.json({ access_token: `access-${token}`, refresh_token: `${token}-discovered`, expires_in: 3600 })
      }
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: { "gemini-3-flash": {} } })
      if (url.endsWith(":retrieveUserQuota")) return Response.json({ buckets: [] })
      return new Response(`data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    })
    const adapter = await host()
    adapter.setCredential({ ...credential(), methodID: Integration.MethodID.make("oauth") }, "native-first")
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    await adapter.accountHandlers!.models({}, context)
    const realStorage = await import("./plugin/storage.ts")
    expect((await realStorage.loadAccounts())!.accounts.map(account => account.refreshToken)).toEqual(["refresh-discovered", "second-discovered"])
    adapter.setCredential({ ...credential("second|project"), methodID: Integration.MethodID.make("oauth") }, "native-second")
    const { sdk } = await adapter.sdk()
    await expect(stream(sdk)).resolves.toContainEqual(expect.objectContaining({ type: "text-delta" }))
  })
})


describe("native loader credential identity", () => {
  it("reloads secondary credentials after quota rotation while a native primary connection stays active", async () => {
    state.storage!.accounts.push({ refreshToken: "second", email: "second@example.test", projectId: "project", enabled: true, addedAt: 1, lastUsed: 1 })
    const firstID = accountID(state.storage!.accounts[0]!)
    const secondID = accountID(state.storage!.accounts[1]!)
    let rotatedSecond = false
    const seen: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) {
        const token = new URLSearchParams(String(init?.body)).get("refresh_token")!
        seen.push(token)
        if (token === "second") {
          if (rotatedSecond) return Response.json({ error: "invalid_grant" }, { status: 400 })
          rotatedSecond = true
          return Response.json({ access_token: "access-second", refresh_token: "second-current", expires_in: 3600 })
        }
        return Response.json({ access_token: `access-${token}`, expires_in: 3600 })
      }
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: { "claude-sonnet-5-5-high": {} } })
      if (url.endsWith(":retrieveUserQuota")) return Response.json({ buckets: [] })
      return new Response(`data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    })
    const adapter = await host({
      catalog: { "gemini-3-flash": {}, "claude-sonnet-5-5-high": {} },
      catalogAccounts: { "antigravity-gemini-3-flash": [firstID], "antigravity-claude-sonnet-5-5-high": [secondID] },
    })
    adapter.setCredential(credential(), "native-first")
    const { sdk } = await adapter.sdk()
    await stream(sdk)
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    await adapter.accountHandlers!.quotas({ id: secondID }, context)
    const realStorage = await import("./plugin/storage.ts")
    expect((await realStorage.loadAccounts())!.accounts[1]!.refreshToken).toBe("second-current")
    const next = await adapter.sdk("antigravity-claude-sonnet-5-5-high")
    await expect(stream(next.sdk, "antigravity-claude-sonnet-5-5-high")).resolves.toContainEqual(expect.objectContaining({ type: "text-delta" }))
    expect(seen).toEqual(["second", "second-current"])
  })
})

describe("final persistent lifecycle audit", () => {
  it("disables a revoked account on disk after transport failover", async () => {
    state.storage!.accounts.push({ refreshToken: "healthy", email: "healthy@example.test", projectId: "project", enabled: true, addedAt: 1, lastUsed: 1 })
    const seen: string[] = []
    const original = mockNetwork().getMockImplementation()!
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) {
        const token = new URLSearchParams(String(init?.body)).get("refresh_token")!
        seen.push(token)
        if (token === "refresh") return Response.json({ error: "invalid_grant" }, { status: 400 })
        return Response.json({ access_token: "healthy-access", refresh_token: "healthy-current", expires_in: 3600 })
      }
      return original(input, init)
    })
    const adapter = await host({ connection: false })
    const { sdk } = await adapter.sdk()
    await expect(stream(sdk)).resolves.toContainEqual(expect.objectContaining({ type: "text-delta" }))
    const storage = await import("./plugin/storage.ts")
    const disk = await storage.loadAccounts()
    expect(seen).toEqual(["refresh", "healthy"])
    expect.soft(disk!.accounts.find(account => account.email === "healthy@example.test")?.refreshToken).toBe("healthy-current")
    expect.soft(disk!.accounts.some(account => account.refreshToken === "refresh" && account.enabled !== false)).toBe(false)
  })

  it("persists a google_search OAuth rotation before the next tool invocation", async () => {
    const seen: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) {
        const token = new URLSearchParams(String(init?.body)).get("refresh_token")!
        seen.push(token)
        if (seen.length > 1 && token === "refresh") return Response.json({ error: "invalid_grant" }, { status: 400 })
        return Response.json({ access_token: "search-access", refresh_token: "search-current", expires_in: 3600 })
      }
      return Response.json({ response: { candidates: [{ content: { parts: [{ text: "search ok" }] } }] } })
    })
    const adapter = await host({ connection: false })
    const context = { signal: new AbortController().signal } as unknown as ToolContext
    const result = await adapter.tool.execute({ query: "synthetic lifecycle review" }, context)
    expect(result).toMatchObject({ content: expect.stringContaining("search ok") })
    const storage = await import("./plugin/storage.ts")
    expect.soft((await storage.loadAccounts())!.accounts[0]!.refreshToken).toBe("search-current")
    await expect(adapter.tool.execute({ query: "synthetic lifecycle review again" }, context)).resolves.toMatchObject({ content: expect.stringContaining("search ok") })
    expect(seen).toEqual(["refresh", "search-current"])
  })

  it.each([[false, 0], [true, 0], [false, 1], [true, 1]] as const)("preserves foreground OAuth rotation when a menu change retires its manager (discovery %s, changed account %s)", async (discoverModels, changedIndex) => {
    state.storage!.accounts.push({ refreshToken: "secondary", email: "secondary@example.test", projectId: "project", enabled: true, addedAt: 1, lastUsed: 1 })
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let oauthCalls = 0
    const original = mockNetwork().getMockImplementation()!
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) {
        if (++oauthCalls === 1) {
          announce()
          await gate
          return Response.json({ access_token: "foreground-access", refresh_token: "foreground-current", expires_in: 3600 })
        }
        return Response.json({ access_token: "discovery-access", expires_in: 3600 })
      }
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: { "gemini-3-flash": {} } })
      if (url.endsWith(":retrieveUserQuota")) return Response.json({ buckets: [] })
      return original(input, init)
    })
    const eligibleIDs = state.storage!.accounts.map(accountID)
    const adapter = await host({ connection: false, discoverModels, catalog: { "gemini-3-flash": {} }, catalogAccounts: { "antigravity-gemini-3-flash": eligibleIDs } })
    const storage = await import("./plugin/storage.ts")
    const changedAccountID = accountID((await storage.loadAccounts())!.accounts[changedIndex]!)
    const { sdk } = await adapter.sdk()
    const request = stream(sdk).then(value => value, error => error)
    await started
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    const changing = adapter.accountHandlers!.update({ id: changedAccountID, action: "disable" }, context)
    try {
      await vi.waitFor(() => expect(state.storage!.accounts[changedIndex]!.enabled).toBe(false))
    } finally { release() }
    await Promise.all([request, changing])
    const disk = await storage.loadAccounts()
    expect(disk!.accounts[changedIndex]!.enabled).toBe(false)
    expect(disk!.accounts[0]!.refreshToken).toBe("foreground-current")
  })
})

describe("independent final quota and selection integration", () => {
  it("persists refresh-token rotation performed by the automatic post-response quota check", async () => {
    const config = await import("./plugin/config/index.ts")
    vi.spyOn(config, "loadConfig").mockReturnValue({ ...DEFAULT_CONFIG, proactive_token_refresh: false, request_jitter_max_ms: 0, quota_refresh_interval_minutes: 15 })
    const cacheUpdate = vi.spyOn(AccountManager.prototype, "updateQuotaCache")
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "quota-access", refresh_token: "automatic-quota-rotated", expires_in: 3600 })
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: { "gemini-3-flash": { quotaInfo: { remainingFraction: 0.8 } } } })
      if (url.endsWith(":retrieveUserQuota")) return Response.json({ buckets: [] })
      return new Response(`data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
    })
    const adapter = await host()
    const { sdk } = await adapter.sdk()
    await stream(sdk)
    await vi.waitFor(() => expect(cacheUpdate).toHaveBeenCalled())
    await adapter.cleanup()
    const storage = await import("./plugin/storage.ts")
    expect((await storage.loadAccounts())?.accounts[0]?.refreshToken).toBe("automatic-quota-rotated")
  })

})

describe("independent concurrent discovery", () => {
  it("retains models for an account enabled while an older discovery is pending", async () => {
    state.storage!.accounts.push({ ...pool().accounts[0]!, email: "second@example.test", refreshToken: "second", enabled: false })
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let primaryCatalogRequests = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) {
        const token = new URLSearchParams(String(init?.body)).get("refresh_token")!
        return Response.json({ access_token: `access-${token}`, expires_in: 3600 })
      }
      if (url.endsWith(":fetchAvailableModels")) {
        const auth = new Headers(init?.headers).get("Authorization")
        if (auth === "Bearer access-refresh") {
          if (++primaryCatalogRequests === 1) { announce(); await gate }
          return Response.json({ models: { "gemini-3-flash": {} } })
        }
        if (auth === "Bearer access-second") return Response.json({ models: { "claude-sonnet-5-5-high": {} } })
        throw new Error(`Unexpected catalog auth: ${auth}`)
      }
      return Response.json({ buckets: [] })
    })
    const firstID = accountID(state.storage!.accounts[0]!)
    const secondID = accountID(state.storage!.accounts[1]!)
    const adapter = await host({ connection: false, discoverModels: true, catalog: { "gemini-3-flash": {} }, catalogAccounts: { "antigravity-gemini-3-flash": [firstID] } })
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    const older = adapter.accountHandlers!.models({}, context)
    await started
    try {
      await adapter.accountHandlers!.update({ id: secondID, action: "enable" }, context)
      expect(adapter.storage.get("model-catalog")).toMatchObject({ models: { "claude-sonnet-5-5-high": {} } })
    } finally { release() }
    await older
    expect(adapter.storage.get("model-catalog")).toMatchObject({ models: { "claude-sonnet-5-5-high": {} }, accounts: { "antigravity-claude-sonnet-5-5-high": [secondID] } })
  })
})

describe("credential operations during adapter replacement", () => {
  it.each(["foreground", "native", "search", "quotas"] as const)("drains %s OAuth through persistence before replacement starts", async kind => {
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tokens: string[] = []
    const original = mockNetwork().getMockImplementation()!
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) {
        const token = new URLSearchParams(String(init?.body)).get("refresh_token")!
        tokens.push(token)
        if (tokens.length === 1) {
          announce()
          await gate
          return Response.json({ access_token: "rotated-access", refresh_token: "retained-current", expires_in: 3600 })
        }
        if (token === "refresh") return Response.json({ error: "invalid_grant" }, { status: 400 })
        return Response.json({ access_token: "valid-current", expires_in: 3600 })
      }
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: { "gemini-3-flash": {} } })
      if (url.endsWith(":retrieveUserQuota")) return Response.json({ buckets: [] })
      return original(input, init)
    })
    const adapter = await host({ connection: false })
    let pending: Promise<unknown>
    if (kind === "foreground") pending = stream((await adapter.sdk()).sdk).catch(error => error)
    else if (kind === "native") pending = adapter.method.refresh!(credential()).catch(error => error)
    else if (kind === "search") pending = Promise.resolve(adapter.tool.execute({ query: "synthetic" }, { signal: new AbortController().signal } as unknown as ToolContext)).catch(error => error)
    else pending = adapter.accountHandlers!.quotas({}, { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } })
    await started
    let cleaned = false
    const closing = Promise.resolve(adapter.cleanup()).then(() => { cleaned = true })
    let secondCleaned = false
    const secondClosing = Promise.resolve(adapter.cleanup()).then(() => { secondCleaned = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(cleaned).toBe(false)
      expect(secondCleaned).toBe(false)
    } finally { release() }
    await Promise.all([closing, secondClosing, pending])
    expect(state.storage!.accounts[0]).toMatchObject({ refreshToken: "retained-current", enabled: true })
    const replacement = await host({ connection: false })
    expect(await stream((await replacement.sdk()).sdk)).toContainEqual(expect.objectContaining({ type: "text-delta" }))
    expect(state.storage!.accounts[0]!.enabled).toBe(true)
    expect(tokens).toEqual(["refresh", "retained-current"])
  })
})

describe("cleanup during automatic quota refresh", () => {
  it("waits for discovery's pending OAuth result and preserves rotation during cleanup", async () => {
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      if (String(input).includes("oauth2.googleapis.com/token")) {
        announce()
        await gate
        return Response.json({ access_token: "discovery-access", refresh_token: "discovery-current", expires_in: 3600 })
      }
      throw new Error("Cleanup should abort discovery before catalog I/O")
    })
    const adapter = await host({ connection: false })
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    const discovery = adapter.accountHandlers!.models({}, context)
    await started
    let cleaned = false
    const cleanup = Promise.resolve(adapter.cleanup()).then(() => { cleaned = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(cleaned).toBe(false)
    } finally { release() }
    await Promise.all([discovery, cleanup])
    expect(state.storage!.accounts[0]).toMatchObject({ refreshToken: "discovery-current", enabled: true })
  })

  it("waits for a pending quota refresh to persist credentials before cleanup completes", async () => {
    const config = await import("./plugin/config/index.ts")
    vi.spyOn(config, "loadConfig").mockReturnValue({ ...DEFAULT_CONFIG, proactive_token_refresh: false, request_jitter_max_ms: 0, quota_refresh_interval_minutes: 15 })
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = mockNetwork().getMockImplementation()!
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) {
        announce()
        await gate
        return Response.json({ access_token: "quota-access", refresh_token: "cleanup-quota-rotated", expires_in: 3600 })
      }
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: { "gemini-3-flash": { quotaInfo: { remainingFraction: 0.8 } } } })
      if (url.endsWith(":retrieveUserQuota")) return Response.json({ buckets: [] })
      return original(input, init)
    })
    const adapter = await host()
    const { sdk } = await adapter.sdk()
    await stream(sdk)
    await started
    let finished = false
    const cleanup = Promise.resolve(adapter.cleanup()).then(() => { finished = true })
    try {
      await vi.waitFor(() => expect(adapter.disposals.every(dispose => dispose.mock.calls.length > 0)).toBe(true))
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(finished).toBe(false)
    } finally { release() }
    await cleanup
    expect(state.storage!.accounts[0]!.refreshToken).toBe("cleanup-quota-rotated")
  })
})

describe("revocation overlapping account changes", () => {
  it.each(["retire", "rotate"] as const)("handles an in-flight rejected token after a concurrent %s", async change => {
    state.storage!.accounts.push({ ...pool().accounts[0]!, email: "second@example.test", refreshToken: "second" })
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const original = mockNetwork().getMockImplementation()!
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("oauth2.googleapis.com/token") && ++calls === 1) {
        announce()
        await gate
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      }
      return original(input, init)
    })
    const adapter = await host({ connection: false })
    const { sdk } = await adapter.sdk()
    const pending = stream(sdk).catch(error => error)
    await started
    try {
      if (change === "retire") {
        const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
        await adapter.accountHandlers!.update({ id: accountID(state.storage!.accounts[1]!), action: "disable" }, context)
      } else {
        const { updateAccounts, updateAccountCredentials } = await import("./plugin/storage.ts")
        await updateAccounts(storage => { updateAccountCredentials(storage.accounts[0]!, { refreshToken: "externally-refreshed" }) })
      }
    } finally { release() }
    await pending
    if (change === "retire") expect(state.storage!.accounts.every(account => account.enabled === false)).toBe(true)
    else expect(state.storage!.accounts[0]).toMatchObject({ refreshToken: "externally-refreshed", enabled: true })
  })
})

describe("independent credential provenance review", () => {
  it.each(["disable", "delete"] as const)("does not start search after %s while OAuth is pending", async action => {
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const searched: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) {
        announce()
        await gate
        return Response.json({ access_token: "retired-search-access", refresh_token: "retired-search-current", expires_in: 3600 })
      }
      if (init?.signal?.aborted) throw init.signal.reason
      searched.push(new Headers(init?.headers).get("Authorization") ?? "")
      return Response.json({ response: { candidates: [{ content: { parts: [{ text: "search performed" }] } }] } })
    })
    const adapter = await host({ connection: false })
    const storage = await import("./plugin/storage.ts")
    const id = (await storage.loadAccounts())!.accounts[0]!.id!
    const task = adapter.tool.execute({ query: "synthetic account boundary test" }, { signal: new AbortController().signal } as unknown as ToolContext).catch(error => error)
    await started
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    try {
      await adapter.accountHandlers!.update({ id, action }, context)
    } finally { release() }
    await task
    const disk = await storage.loadAccounts()
    if (action === "delete") expect(disk!.accounts).toHaveLength(0)
    else expect(disk!.accounts[0]).toMatchObject({ enabled: false, refreshToken: "retired-search-current" })
    expect(searched).toEqual([])
  })

})

describe("final async boundary audit", () => {
  it("keeps the latest catalog when an older cache write completes last", async () => {
    const primaryID = accountID(state.storage!.accounts[0]!)
    const adapter = await host({ connection: false, catalog: { "gemini-3-flash": {} }, catalogAccounts: { "antigravity-gemini-3-flash": [primaryID] } })
    let catalogs = 0
    const sentModels: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "catalog-access", expires_in: 3600 })
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: ++catalogs === 1 ? { "gemini-3-flash": {}, "claude-sonnet-5-5-high": {} } : { "gemini-3-flash": {} } })
      if (url.includes(":streamGenerateContent")) {
        const body = JSON.parse(input instanceof Request ? await input.clone().text() : String(init?.body))
        sentModels.push(body.model)
        return new Response(`data: ${JSON.stringify({ response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "stale model dispatched" }] }, finishReason: "STOP" }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
      }
      return Response.json({ buckets: [] })
    })
    let announce!: () => void
    const writing = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalSet = vi.mocked(adapter.ctx.storage.set).getMockImplementation()!
    let writes = 0
    vi.mocked(adapter.ctx.storage.set).mockImplementation(async (key, value) => {
      if (key === "model-catalog" && ++writes === 1) { announce(); await gate }
      return originalSet(key, value)
    })
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    const older = adapter.accountHandlers!.models({}, context)
    await writing
    try {
      await adapter.accountHandlers!.models({}, context)
      expect(adapter.storage.get("model-catalog")).toMatchObject({ models: { "gemini-3-flash": {} } })
      expect((adapter.storage.get("model-catalog") as { models: Record<string, unknown> }).models).not.toHaveProperty("claude-sonnet-5-5-high")
    } finally { release() }
    await older
    const cached = adapter.storage.get("model-catalog") as { models: Record<string, AvailableModel>; accounts: Record<string, string[]> }
    expect.soft(cached.models).not.toHaveProperty("claude-sonnet-5-5-high")
    const restarted = await host({ connection: false, catalog: cached.models, catalogAccounts: cached.accounts })
    await expect(restarted.sdk("antigravity-claude-sonnet-5-5-high")).rejects.toThrow("Missing model")
    expect(sentModels).toHaveLength(0)
  })

})

describe("native connection switch during refresh", () => {
  it("does not mark an unbound active connection when an inactive account is revoked", async () => {
    state.storage!.accounts.push({ ...pool().accounts[0]!, refreshToken: "revoked-B", email: "revoked-B@example.test" })
    const adapter = await host()
    adapter.setCredential(credential(), "native-A")
    const nativeA = { type: "credential", id: Credential.ID.make("native-A"), method: "oauth" } as const
    const nativeB = { type: "credential", id: Credential.ID.make("native-B"), method: "oauth" } as const
    Object.assign(adapter.ctx.integration, { get: async () => ({ data: { connections: [nativeA, nativeB] } }) })
    Object.assign(adapter.ctx.integration.connection, { resolve: async (connection: ConnectionInfo) => connection.type === "credential" && connection.id === "native-B" ? adapter.method.refresh!(credential("revoked-B|project")) : credential() })
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }))
    const id = accountID(state.storage!.accounts[1]!)
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    await adapter.accountHandlers!.connections({ id }, context)
    expect(state.storage!.accounts[0]!.enabled).toBe(true)
    expect(state.storage!.accounts[1]!.enabled).toBe(false)
    expect(state.connectionStatus).not.toHaveBeenCalled()
  })

  it("does not report a rejected A refresh as needs_auth on healthy active B", async () => {
    state.storage!.accounts.push({ ...pool().accounts[0]!, refreshToken: "healthy-secondary", email: "secondary@example.test" })
    const adapter = await host()
    adapter.setCredential(credential(), "native-A")
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      if (String(input).includes("oauth2.googleapis.com/token")) {
        announce()
        await gate
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      }
      throw new Error("Unexpected network operation")
    })
    const pending = adapter.method.refresh!(credential())
    await started
    adapter.setCredential(credential("healthy-secondary|project"), "native-B")
    release()
    await pending
    const realStorage = await import("./plugin/storage.ts")
    expect((await realStorage.loadAccounts())!.accounts[1]).toMatchObject({ enabled: true, refreshToken: "healthy-secondary" })
    expect(state.connectionStatus.mock.calls.some(([input]) => input.connection.type === "credential" && input.connection.id === "native-B" && input.status?.status === "needs_auth")).toBe(false)
  })
})

describe("retired manager control and deletion invariants", () => {
  it.each([false, true])("persists a refresh derived from adopted stored credentials (retired=%s)", async retired => {
    const stored = { ...pool(), accounts: [{ ...pool().accounts[0]!, id: "stable-first" }] }
    state.storage = structuredClone(stored)
    const manager = new AccountManager(undefined, stored, true)
    manager.useManagedStorage()
    const account = manager.getAccounts()[0]!
    state.storage.accounts[0]!.refreshToken = "adopted-current"
    manager.updateFromAuth(account, { type: "oauth", refresh: "adopted-current|project", access: "current" }, "refresh")
    if (retired) await manager.retire()
    manager.updateFromAuth(account, { type: "oauth", refresh: "descendant-current|project", access: "fresh" }, "adopted-current")
    await manager.saveToDisk()
    await manager.retire()
    expect(state.storage.accounts[0]!.refreshToken).toBe("descendant-current")
  })

  it.each(["disable", "delete"] as const)("does not undo %s when saving a later OAuth rotation", async action => {
    const { AccountManager } = await import("./plugin/accounts.ts")
    const storage = await import("./plugin/storage.ts")
    const first = { ...pool().accounts[0]!, id: "stable-first" }
    const second = { ...first, id: "stable-second", refreshToken: "second", email: "second@example.test" }
    const stored = { version: 4 as const, accounts: [first, second], activeIndex: 0, activeIndexByFamily: { claude: 0, gemini: 0 } }
    await storage.saveAccountsReplace(stored)
    const manager = new AccountManager(undefined, stored)
    manager.useManagedStorage()
    await manager.retire()
    await storage.updateAccounts(current => {
      if (action === "delete") current.accounts.splice(0, 1)
      else current.accounts[0]!.enabled = false
      const active = current.accounts.findIndex(account => account.id === "stable-second")
      current.activeIndex = active
      current.activeIndexByFamily = { claude: active, gemini: active }
      current.accounts[active]!.lastUsed = 938
      current.accounts[active]!.cachedQuotaUpdatedAt = 48
    })
    const account = manager.getAccounts()[0]!
    manager.updateFromAuth(account, { type: "oauth", refresh: "retired-current|project", access: "fresh", expires: Date.now() + 3600_000 }, "refresh")
    await manager.saveToDisk()
    const disk = await storage.loadAccounts()
    const saved = disk!.accounts.find(account => account.id === "stable-first")
    if (action === "delete") expect(saved).toBeUndefined()
    else expect(saved).toMatchObject({ enabled: false, refreshToken: "retired-current" })
    const active = disk!.accounts.findIndex(account => account.id === "stable-second")
    expect(disk).toMatchObject({ activeIndex: active, activeIndexByFamily: { claude: active, gemini: active } })
    expect(disk!.accounts[active]).toMatchObject({ lastUsed: 938, cachedQuotaUpdatedAt: 48 })
  })
})

describe("OAuth completing during an earlier save", () => {
  function pauseNextSave() {
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const install = async () => {
      const storage = await import("./plugin/storage.ts")
      vi.spyOn(storage, "updateAccounts").mockImplementationOnce(async update => {
        const saved = structuredClone(state.storage!)
        update(saved)
        announce()
        await gate
        state.storage = saved
        return saved
      })
    }
    return { started, release: () => release(), install }
  }

  it("retains a newer token when an earlier save commits its old snapshot", async () => {
    state.storage!.accounts[0]!.id = accountID(state.storage!.accounts[0]!)
    const manager = new AccountManager(undefined, structuredClone(state.storage))
    manager.useManagedStorage()
    const account = manager.getAccounts()[0]!
    const gate = pauseNextSave()
    await gate.install()
    const first = manager.saveToDisk()
    await gate.started
    manager.updateFromAuth(account, { type: "oauth", refresh: "latest-foreground-token|project", access: "new" }, "refresh")
    const second = manager.saveToDisk()
    gate.release()
    await Promise.all([first, second])
    await manager.retire()
    expect(state.storage!.accounts[0]!.refreshToken).toBe("latest-foreground-token")
  })

  it("preserves OAuth completing while retirement drains an older save before disabling the account", async () => {
    let announce!: () => void
    const started = new Promise<void>(resolve => { announce = resolve })
    let release!: () => void
    const oauthGate = new Promise<void>(resolve => { release = resolve })
    const original = mockNetwork().getMockImplementation()!
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("oauth2.googleapis.com/token")) {
        announce()
        await oauthGate
        return Response.json({ access_token: "new", refresh_token: "latest-foreground-token", expires_in: 3600 })
      }
      return original(input, init)
    })
    const adapter = await host({ connection: false })
    const id = accountID(state.storage!.accounts[0]!)
    const { sdk } = await adapter.sdk()
    const request = stream(sdk).catch(error => error)
    await started
    const gate = pauseNextSave()
    await gate.install()
    let updated!: () => void
    const authUpdated = new Promise<void>(resolve => { updated = resolve })
    const originalUpdate = AccountManager.prototype.updateFromAuth
    vi.spyOn(AccountManager.prototype, "updateFromAuth").mockImplementation(function (this: AccountManager, account, auth, previousToken) {
      originalUpdate.call(this, account, auth, previousToken)
      if (auth.refresh.startsWith("latest-foreground-token")) updated()
    })
    const context = { signal: new AbortController().signal, error: () => { throw new Error("Unexpected RPC error") } }
    const disabling = adapter.accountHandlers!.update({ id, action: "disable" }, context)
    await gate.started
    release()
    await authUpdated
    await new Promise<void>(resolve => setImmediate(resolve))
    gate.release()
    await Promise.all([request, disabling])
    expect(state.storage!.accounts[0]).toMatchObject({ enabled: false, refreshToken: "latest-foreground-token" })
  })
})

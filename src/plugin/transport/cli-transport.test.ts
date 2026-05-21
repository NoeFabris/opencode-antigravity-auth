import { describe, it, expect } from "vitest"
import { createCliTransport } from "./cli-transport.ts"
import type { CliTransportConfig } from "./cli-transport.ts"
import type { PrepareTransportRequestContext } from "./types.ts"

const defaultConfig: CliTransportConfig = {
  enabled: true,
  print_timeout_seconds: 60,
  process_timeout_seconds: 90,
  dangerously_skip_permissions: true,
}

const generativeLanguageUrl =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"

function makeContext(body: Record<string, unknown>): PrepareTransportRequestContext {
  return {
    input: "opencode-antigravity://cli/agy-print",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    accessToken: "",
    projectId: "",
    headerStyle: "antigravity",
  }
}

// ---------------------------------------------------------------------------
// Identity and auth
// ---------------------------------------------------------------------------

describe("CliTransport identity", () => {
  it("has id 'cli'", () => {
    const transport = createCliTransport(defaultConfig)
    expect(transport.id).toBe("cli")
  })

  it("has label containing 'CLI'", () => {
    const transport = createCliTransport(defaultConfig)
    expect(transport.label).toContain("CLI")
  })

  it("matches when enabled", () => {
    const transport = createCliTransport(defaultConfig)
    expect(transport.matches(generativeLanguageUrl)).toBe(true)
  })

  it("does not match when disabled", () => {
    const transport = createCliTransport({ ...defaultConfig, enabled: false })
    expect(transport.matches(generativeLanguageUrl)).toBe(false)
  })

  it("does not match non-Generative-Language requests", () => {
    const transport = createCliTransport(defaultConfig)
    expect(transport.matches("https://api.openai.com/v1/chat/completions")).toBe(false)
  })

  it("does not require OAuth", () => {
    const transport = createCliTransport(defaultConfig)
    expect(transport.auth.requiresOAuth).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe("CliTransport.getRequestMetadata", () => {
  it("returns agent family and agy model", () => {
    const transport = createCliTransport(defaultConfig)
    const meta = transport.getRequestMetadata("")
    expect(meta.family).toBe("agent")
    expect(meta.model).toBe("agy")
  })
})

// ---------------------------------------------------------------------------
// prepareRequest
// ---------------------------------------------------------------------------

describe("CliTransport.prepareRequest", () => {
  it("extracts prompt from contents[].parts[].text", () => {
    const transport = createCliTransport(defaultConfig)
    const ctx = makeContext({
      contents: [
        { role: "user", parts: [{ text: "Hello world" }] },
      ],
    })

    const prepared = transport.prepareRequest(ctx)
    expect(prepared.action).toBe("agy-print")
    expect(prepared.streaming).toBe(false)
    expect(prepared.transportPayload).toBeDefined()
  })

  it("extracts prompt from messages[].content", () => {
    const transport = createCliTransport(defaultConfig)
    const ctx = makeContext({
      messages: [
        { role: "user", content: "Hi from messages" },
      ],
    })

    const prepared = transport.prepareRequest(ctx)
    const command = prepared.transportPayload as { args: string[] }
    expect(command.args).toContain("Hi from messages")
  })

  it("extracts prompt from top-level 'prompt' field", () => {
    const transport = createCliTransport(defaultConfig)
    const ctx = makeContext({ prompt: "Top-level prompt" })

    const prepared = transport.prepareRequest(ctx)
    const command = prepared.transportPayload as { args: string[] }
    expect(command.args).toContain("Top-level prompt")
  })

  it("throws when no prompt can be extracted", () => {
    const transport = createCliTransport(defaultConfig)
    const ctx = makeContext({})

    expect(() => transport.prepareRequest(ctx)).toThrow("could not extract a text prompt")
  })

  it("includes --dangerously-skip-permissions when enabled", () => {
    const transport = createCliTransport(defaultConfig)
    const ctx = makeContext({ prompt: "test" })

    const prepared = transport.prepareRequest(ctx)
    const command = prepared.transportPayload as { args: string[] }
    expect(command.args).toContain("--dangerously-skip-permissions")
  })

  it("omits --dangerously-skip-permissions when disabled", () => {
    const transport = createCliTransport({ ...defaultConfig, dangerously_skip_permissions: false })
    const ctx = makeContext({ prompt: "test" })

    const prepared = transport.prepareRequest(ctx)
    const command = prepared.transportPayload as { args: string[] }
    expect(command.args).not.toContain("--dangerously-skip-permissions")
  })

  it("includes --sandbox when enabled", () => {
    const transport = createCliTransport({ ...defaultConfig, sandbox: true })
    const ctx = makeContext({ prompt: "test" })

    const prepared = transport.prepareRequest(ctx)
    const command = prepared.transportPayload as { args: string[] }
    expect(command.args).toContain("--sandbox")
  })

  it("includes --log-file when set", () => {
    const transport = createCliTransport({ ...defaultConfig, log_file: "/tmp/agy.log" })
    const ctx = makeContext({ prompt: "test" })

    const prepared = transport.prepareRequest(ctx)
    const command = prepared.transportPayload as { args: string[] }
    expect(command.args).toContain("--log-file")
    expect(command.args).toContain("/tmp/agy.log")
  })

  it("uses custom binary when configured", () => {
    const transport = createCliTransport({ ...defaultConfig, binary: "/usr/local/bin/agy" })
    const ctx = makeContext({ prompt: "test" })

    const prepared = transport.prepareRequest(ctx)
    const command = prepared.transportPayload as { binary: string }
    expect(command.binary).toBe("/usr/local/bin/agy")
  })

  it("sets timeout from config", () => {
    const transport = createCliTransport({ ...defaultConfig, process_timeout_seconds: 120 })
    const ctx = makeContext({ prompt: "test" })

    const prepared = transport.prepareRequest(ctx)
    const command = prepared.transportPayload as { timeoutMs: number }
    expect(command.timeoutMs).toBe(120_000)
  })
})

// ---------------------------------------------------------------------------
// transformResponse
// ---------------------------------------------------------------------------

describe("CliTransport.transformResponse", () => {
  it("transforms stdout into Gemini text response", async () => {
    const transport = createCliTransport(defaultConfig)
    const prepared = transport.prepareRequest(makeContext({ prompt: "test" }))

    const agyResponse = Response.json({ stdout: "Hello from agy!", stderr: "" })
    const result = await transport.transformResponse({ response: agyResponse, prepared })

    expect(result.status).toBe(200)
    const body = await result.json()
    expect(body.candidates[0].content.parts[0].text).toBe("Hello from agy!")
    expect(body.candidates[0].finishReason).toBe("STOP")
  })

  it("passes through error responses unchanged", async () => {
    const transport = createCliTransport(defaultConfig)
    const prepared = transport.prepareRequest(makeContext({ prompt: "test" }))

    const errorResponse = Response.json(
      { error: { code: 401, message: "not authenticated" } },
      { status: 401 },
    )
    const result = await transport.transformResponse({ response: errorResponse, prepared })

    expect(result.status).toBe(401)
  })

  it("handles empty stdout", async () => {
    const transport = createCliTransport(defaultConfig)
    const prepared = transport.prepareRequest(makeContext({ prompt: "test" }))

    const agyResponse = Response.json({ stdout: "", stderr: "" })
    const result = await transport.transformResponse({ response: agyResponse, prepared })

    const body = await result.json()
    expect(body.candidates[0].content.parts[0].text).toBe("")
  })
})

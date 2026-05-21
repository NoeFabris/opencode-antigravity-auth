import { describe, it, expect } from "vitest"
import { createManagedAgentTransport } from "./managed-agent-transport.ts"
import type { ManagedAgentTransportConfig } from "./managed-agent-transport.ts"
import type { PrepareTransportRequestContext } from "./types.ts"

const defaultConfig: ManagedAgentTransportConfig = {
  enabled: true,
  api_key: "test-api-key-12345",
  stream: false,
}

const generativeLanguageUrl =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"

function makeContext(body: Record<string, unknown>): PrepareTransportRequestContext {
  return {
    input: "opencode-antigravity://managed-agent/interaction",
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

describe("ManagedAgentTransport identity", () => {
  it("has id 'managed-agent'", () => {
    const transport = createManagedAgentTransport(defaultConfig)
    expect(transport.id).toBe("managed-agent")
  })

  it("has label containing 'Managed'", () => {
    const transport = createManagedAgentTransport(defaultConfig)
    expect(transport.label).toContain("Managed")
  })

  it("matches when enabled", () => {
    const transport = createManagedAgentTransport(defaultConfig)
    expect(transport.matches(generativeLanguageUrl)).toBe(true)
  })

  it("does not match when disabled", () => {
    const transport = createManagedAgentTransport({ ...defaultConfig, enabled: false })
    expect(transport.matches(generativeLanguageUrl)).toBe(false)
  })

  it("does not match non-Generative-Language requests", () => {
    const transport = createManagedAgentTransport(defaultConfig)
    expect(transport.matches("https://api.openai.com/v1/chat/completions")).toBe(false)
  })

  it("does not require OAuth", () => {
    const transport = createManagedAgentTransport(defaultConfig)
    expect(transport.auth.requiresOAuth).toBe(false)
  })

  it("does not require project context", () => {
    const transport = createManagedAgentTransport(defaultConfig)
    expect(transport.auth.requiresProjectContext).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe("ManagedAgentTransport.getRequestMetadata", () => {
  it("returns agent family and base agent model", () => {
    const transport = createManagedAgentTransport(defaultConfig)
    const meta = transport.getRequestMetadata("")
    expect(meta.family).toBe("agent")
    expect(meta.model).toBe("antigravity-preview-05-2026")
  })
})

// ---------------------------------------------------------------------------
// prepareRequest
// ---------------------------------------------------------------------------

describe("ManagedAgentTransport.prepareRequest", () => {
  it("builds Interactions API request with API key header", () => {
    const transport = createManagedAgentTransport(defaultConfig)
    const ctx = makeContext({
      contents: [
        { role: "user", parts: [{ text: "Explain quantum computing" }] },
      ],
    })

    const prepared = transport.prepareRequest(ctx)
    expect(prepared.action).toBe("managed-agent-interaction")
    expect(prepared.endpoint).toContain("/v1beta/interactions")

    const headers = new Headers(prepared.init.headers as HeadersInit)
    expect(headers.get("x-goog-api-key")).toBe("test-api-key-12345")
    expect(headers.get("Api-Revision")).toBe("2026-05-20")
    expect(headers.get("Content-Type")).toBe("application/json")
  })

  it("extracts input from contents[].parts[].text", () => {
    const transport = createManagedAgentTransport(defaultConfig)
    const ctx = makeContext({
      contents: [
        { role: "user", parts: [{ text: "Hello" }] },
        { role: "model", parts: [{ text: "Hi there" }] },
        { role: "user", parts: [{ text: "How are you?" }] },
      ],
    })

    const prepared = transport.prepareRequest(ctx)
    const body = JSON.parse(prepared.init.body as string)
    expect(body.input).toBe("Hello\n\nHi there\n\nHow are you?")
    expect(body.agent).toBe("antigravity-preview-05-2026")
  })

  it("extracts input from top-level 'input' field", () => {
    const transport = createManagedAgentTransport(defaultConfig)
    const ctx = makeContext({ input: "Direct input" })

    const prepared = transport.prepareRequest(ctx)
    const body = JSON.parse(prepared.init.body as string)
    expect(body.input).toBe("Direct input")
  })

  it("includes previous_interaction_id when present", () => {
    const transport = createManagedAgentTransport(defaultConfig)
    const ctx = makeContext({
      input: "Follow-up",
      previous_interaction_id: "interaction-abc-123",
    })

    const prepared = transport.prepareRequest(ctx)
    const body = JSON.parse(prepared.init.body as string)
    expect(body.previous_interaction_id).toBe("interaction-abc-123")
  })

  it("includes system_instruction when configured", () => {
    const transport = createManagedAgentTransport({
      ...defaultConfig,
      system_instruction: "You are a helpful coding assistant.",
    })
    const ctx = makeContext({ input: "Hello" })

    const prepared = transport.prepareRequest(ctx)
    const body = JSON.parse(prepared.init.body as string)
    expect(body.system_instruction).toBe("You are a helpful coding assistant.")
  })

  it("includes environment when configured", () => {
    const transport = createManagedAgentTransport({
      ...defaultConfig,
      environment: { sources: [{ uri: "file:///project" }] },
    })
    const ctx = makeContext({ input: "Hello" })

    const prepared = transport.prepareRequest(ctx)
    const body = JSON.parse(prepared.init.body as string)
    expect(body.environment).toEqual({ sources: [{ uri: "file:///project" }] })
  })

  it("throws when api_key is empty", () => {
    const transport = createManagedAgentTransport({ ...defaultConfig, api_key: "" })
    const ctx = makeContext({ input: "Hello" })

    expect(() => transport.prepareRequest(ctx)).toThrow("requires transport.managed_agent.api_key")
  })

  it("throws when no input can be extracted", () => {
    const transport = createManagedAgentTransport(defaultConfig)
    const ctx = makeContext({})

    expect(() => transport.prepareRequest(ctx)).toThrow("could not extract input text")
  })

  it("sets streaming from config", () => {
    const transport = createManagedAgentTransport({ ...defaultConfig, stream: true })
    const ctx = makeContext({ input: "Hello" })

    const prepared = transport.prepareRequest(ctx)
    expect(prepared.streaming).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// transformResponse
// ---------------------------------------------------------------------------

describe("ManagedAgentTransport.transformResponse", () => {
  it("extracts text from output field", async () => {
    const transport = createManagedAgentTransport(defaultConfig)
    const prepared = transport.prepareRequest(makeContext({ input: "test" }))

    const apiResponse = Response.json({
      output: "This is the response",
      interaction_id: "int-123",
    })
    const result = await transport.transformResponse({ response: apiResponse, prepared })

    expect(result.status).toBe(200)
    const body = await result.json()
    expect(body.candidates[0].content.parts[0].text).toBe("This is the response")
    expect(body.interactionId).toBe("int-123")
  })

  it("extracts text from candidates[].content.parts[].text", async () => {
    const transport = createManagedAgentTransport(defaultConfig)
    const prepared = transport.prepareRequest(makeContext({ input: "test" }))

    const apiResponse = Response.json({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Response via candidates" }],
          },
        },
      ],
    })
    const result = await transport.transformResponse({ response: apiResponse, prepared })

    const body = await result.json()
    expect(body.candidates[0].content.parts[0].text).toBe("Response via candidates")
  })

  it("passes through error responses with message", async () => {
    const transport = createManagedAgentTransport(defaultConfig)
    const prepared = transport.prepareRequest(makeContext({ input: "test" }))

    const errorResponse = Response.json(
      { error: { message: "API key invalid" } },
      { status: 403 },
    )
    const result = await transport.transformResponse({ response: errorResponse, prepared })

    expect(result.status).toBe(403)
    const body = await result.json()
    expect(body.error.message).toBe("API key invalid")
  })

  it("returns generic error message when error body is not JSON", async () => {
    const transport = createManagedAgentTransport(defaultConfig)
    const prepared = transport.prepareRequest(makeContext({ input: "test" }))

    const errorResponse = new Response("Internal Server Error", { status: 500 })
    const result = await transport.transformResponse({ response: errorResponse, prepared })

    expect(result.status).toBe(500)
    const body = await result.json()
    expect(body.error.message).toContain("HTTP 500")
  })

  it("passes through streaming responses as-is", async () => {
    const transport = createManagedAgentTransport({ ...defaultConfig, stream: true })
    const prepared = transport.prepareRequest(makeContext({ input: "test" }))

    const sseResponse = new Response("event: chunk\ndata: test\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
    const result = await transport.transformResponse({ response: sseResponse, prepared })

    // Streaming responses returned as-is
    expect(result.headers.get("content-type")).toBe("text/event-stream")
  })
})

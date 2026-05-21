import { describe, it, expect } from "vitest"
import { gatewayTransport } from "./gateway-transport.ts"
import {
  isGenerativeLanguageRequest,
  prepareAntigravityRequest,
} from "../request.ts"

// ---------------------------------------------------------------------------
// Request recognition
// ---------------------------------------------------------------------------

describe("gatewayTransport.matches", () => {
  it("matches generativelanguage.googleapis.com URLs", () => {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent"
    expect(gatewayTransport.matches(url)).toBe(true)
  })

  it("does not match non-Google URLs", () => {
    expect(gatewayTransport.matches("https://api.openai.com/v1/chat/completions")).toBe(false)
  })

  it("does not match other googleapis.com subdomains", () => {
    expect(gatewayTransport.matches("https://storage.googleapis.com/bucket/file")).toBe(false)
  })

  it("is consistent with isGenerativeLanguageRequest()", () => {
    const urls = [
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
      "https://api.openai.com/v1/chat",
      "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
    ]
    for (const url of urls) {
      expect(gatewayTransport.matches(url)).toBe(isGenerativeLanguageRequest(url))
    }
  })
})

// ---------------------------------------------------------------------------
// Request metadata extraction
// ---------------------------------------------------------------------------

describe("gatewayTransport.getRequestMetadata", () => {
  it("extracts gemini family and model", () => {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent"
    const meta = gatewayTransport.getRequestMetadata(url)
    expect(meta.family).toBe("gemini")
    expect(meta.model).toBe("gemini-2.5-pro")
  })

  it("extracts claude family and model", () => {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:streamGenerateContent"
    const meta = gatewayTransport.getRequestMetadata(url)
    expect(meta.family).toBe("claude")
    expect(meta.model).toBe("claude-3-7-sonnet")
  })

  it("returns gemini family when no model is found", () => {
    const url = "https://generativelanguage.googleapis.com/v1beta/models"
    const meta = gatewayTransport.getRequestMetadata(url)
    expect(meta.family).toBe("gemini")
    expect(meta.model).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Auth requirements
// ---------------------------------------------------------------------------

describe("gatewayTransport.auth", () => {
  it("requires OAuth", () => {
    expect(gatewayTransport.auth.requiresOAuth).toBe(true)
  })

  it("requires project context", () => {
    expect(gatewayTransport.auth.requiresProjectContext).toBe(true)
  })

  it("supports multi-account", () => {
    expect(gatewayTransport.auth.supportsMultiAccount).toBe(true)
  })

  it("supports header style", () => {
    expect(gatewayTransport.auth.supportsHeaderStyle).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Transport identity
// ---------------------------------------------------------------------------

describe("gatewayTransport identity", () => {
  it("has id 'gateway'", () => {
    expect(gatewayTransport.id).toBe("gateway")
  })

  it("has a non-empty label", () => {
    expect(gatewayTransport.label.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Wrapper equivalence: prepareRequest delegates to prepareAntigravityRequest
// ---------------------------------------------------------------------------

describe("gatewayTransport.prepareRequest equivalence", () => {
  const geminiUrl =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent"
  const accessToken = "test-access-token"
  const projectId = "test-project-id"
  const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Hello" }] }] })
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "should-be-removed" },
    body,
  }

  it("produces the same result as calling prepareAntigravityRequest directly", () => {
    const direct = prepareAntigravityRequest(
      geminiUrl,
      init,
      accessToken,
      projectId,
      undefined,
      "antigravity",
      false,
      undefined,
    )

    const viaTransport = gatewayTransport.prepareRequest({
      input: geminiUrl,
      init,
      accessToken,
      projectId,
      headerStyle: "antigravity",
    })

    expect(viaTransport.streaming).toBe(direct.streaming)
    expect(viaTransport.action).toBe(direct.action)
    expect(viaTransport.requestedModel).toBe(direct.requestedModel)
    expect(viaTransport.effectiveModel).toBe(direct.effectiveModel)
    expect(viaTransport.headerStyle).toBe(direct.headerStyle)
  })

  it("sets Authorization header and removes x-api-key", () => {
    const result = gatewayTransport.prepareRequest({
      input: geminiUrl,
      init,
      accessToken,
      projectId,
      headerStyle: "antigravity",
    })

    const headers = new Headers(result.init.headers)
    expect(headers.get("Authorization")).toBe(`Bearer ${accessToken}`)
    expect(headers.get("x-api-key")).toBeNull()
  })

  it("detects streaming action", () => {
    const result = gatewayTransport.prepareRequest({
      input: geminiUrl,
      init,
      accessToken,
      projectId,
      headerStyle: "antigravity",
    })
    expect(result.streaming).toBe(true)
    expect(result.action).toBe("streamGenerateContent")
  })

  it("detects non-streaming action", () => {
    const nonStreamUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"
    const result = gatewayTransport.prepareRequest({
      input: nonStreamUrl,
      init,
      accessToken,
      projectId,
      headerStyle: "antigravity",
    })
    expect(result.streaming).toBe(false)
    expect(result.action).toBe("generateContent")
  })

  it("transforms URL to Antigravity endpoint", () => {
    const result = gatewayTransport.prepareRequest({
      input: geminiUrl,
      init,
      accessToken,
      projectId,
      headerStyle: "antigravity",
    })
    const requestUrl = typeof result.request === "string" ? result.request : result.request.url
    expect(requestUrl).not.toContain("generativelanguage.googleapis.com")
    expect(requestUrl).toContain("googleapis.com")
  })

  it("uses gemini-cli endpoint for gemini-cli header style", () => {
    const result = gatewayTransport.prepareRequest({
      input: geminiUrl,
      init,
      accessToken,
      projectId,
      headerStyle: "gemini-cli",
    })
    const requestUrl = typeof result.request === "string" ? result.request : result.request.url
    expect(requestUrl).toContain("cloudcode-pa.googleapis.com")
    expect(result.headerStyle).toBe("gemini-cli")
  })
})

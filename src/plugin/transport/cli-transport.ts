import type {
  PreparedTransportRequest,
  PrepareTransportRequestContext,
  TransformTransportResponseContext,
  Transport,
  TransportRequestMetadata,
} from "./types"
import { isGenerativeLanguageRequest } from "../request"
import type { AgyCommand } from "./agy-cli"

export interface CliTransportConfig {
  enabled: boolean
  binary?: string
  print_timeout_seconds: number
  process_timeout_seconds: number
  log_file?: string
  sandbox?: boolean
  dangerously_skip_permissions: boolean
}

function readJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") return {}
  try {
    const parsed = JSON.parse(init.body)
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function extractPrompt(body: Record<string, unknown>): string {
  if (typeof body["prompt"] === "string") return body["prompt"]

  const contents = body["contents"]
  if (Array.isArray(contents)) {
    return contents
      .flatMap((content) => {
        if (!content || typeof content !== "object") return []
        const parts = (content as Record<string, unknown>)["parts"]
        if (!Array.isArray(parts)) return []
        return parts
          .map((part) => {
            if (!part || typeof part !== "object") return ""
            const text = (part as Record<string, unknown>)["text"]
            return typeof text === "string" ? text : ""
          })
          .filter(Boolean)
      })
      .join("\n\n")
  }

  const messages = body["messages"]
  if (Array.isArray(messages)) {
    return messages
      .map((message) => {
        if (!message || typeof message !== "object") return ""
        const content = (message as Record<string, unknown>)["content"]
        if (typeof content === "string") return content
        if (!Array.isArray(content)) return ""
        return content
          .map((part) => {
            if (!part || typeof part !== "object") return ""
            const text = (part as Record<string, unknown>)["text"]
            return typeof text === "string" ? text : ""
          })
          .filter(Boolean)
          .join("\n")
      })
      .filter(Boolean)
      .join("\n\n")
  }

  return ""
}

function geminiTextResponse(text: string): Response {
  return Response.json({
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text }],
        },
        finishReason: "STOP",
      },
    ],
  })
}

export function createCliTransport(config: CliTransportConfig): Transport {
  return {
    id: "cli",
    label: "Antigravity CLI",

    matches(input: RequestInfo): boolean {
      return config.enabled && isGenerativeLanguageRequest(input)
    },

    getRequestMetadata(): TransportRequestMetadata {
      return {
        family: "agent",
        model: "agy",
      }
    },

    auth: {
      requiresOAuth: false,
      requiresProjectContext: false,
      supportsMultiAccount: false,
      supportsHeaderStyle: false,
    },

    prepareRequest(ctx: PrepareTransportRequestContext): PreparedTransportRequest {
      const body = readJsonBody(ctx.init)
      const prompt = extractPrompt(body)

      if (!prompt.trim()) {
        throw new Error("CliTransport could not extract a text prompt from the request body.")
      }

      const args = [
        "--print",
        prompt,
        "--print-timeout",
        `${config.print_timeout_seconds}s`,
      ]

      if (config.log_file) {
        args.push("--log-file", config.log_file)
      }

      if (config.sandbox) {
        args.push("--sandbox")
      }

      if (config.dangerously_skip_permissions) {
        args.push("--dangerously-skip-permissions")
      }

      const command: AgyCommand = {
        binary: config.binary ?? "agy",
        args,
        timeoutMs: config.process_timeout_seconds * 1000,
      }

      return {
        request: "opencode-antigravity://cli/agy-print",
        init: { method: "POST" },
        streaming: false,
        action: "agy-print",
        requestedModel: "agy",
        effectiveModel: "agy",
        headerStyle: "antigravity",
        transportPayload: command,
      }
    },

    async transformResponse(ctx: TransformTransportResponseContext): Promise<Response> {
      if (!ctx.response.ok) return ctx.response

      const payload = await ctx.response.json() as { stdout?: unknown; stderr?: unknown }
      const stdout = typeof payload.stdout === "string" ? payload.stdout : ""

      return geminiTextResponse(stdout.trim())
    },
  }
}

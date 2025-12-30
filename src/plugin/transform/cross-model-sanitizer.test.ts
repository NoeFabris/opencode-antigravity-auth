import { describe, it, expect } from "vitest";
import {
  getModelFamily,
  stripGeminiThinkingMetadata,
  stripClaudeThinkingFields,
  sanitizeCrossModelPayload,
  deepSanitizeCrossModelMetadata,
  sanitizeCrossModelPayloadInPlace,
} from "./cross-model-sanitizer";

describe("cross-model-sanitizer", () => {
  describe("getModelFamily", () => {
    it("identifies Claude models", () => {
      expect(getModelFamily("claude-opus-4-5-thinking-medium")).toBe("claude");
      expect(getModelFamily("claude-sonnet-4-5")).toBe("claude");
      expect(getModelFamily("claude-sonnet-4-5-thinking-low")).toBe("claude");
    });

    it("identifies Gemini models", () => {
      expect(getModelFamily("gemini-3-pro-low")).toBe("gemini");
      expect(getModelFamily("gemini-3-flash")).toBe("gemini");
      expect(getModelFamily("gemini-2.5-pro")).toBe("gemini");
    });

    it("returns unknown for unrecognized models", () => {
      expect(getModelFamily("gpt-4")).toBe("unknown");
      expect(getModelFamily("unknown-model")).toBe("unknown");
    });
  });

  describe("stripGeminiThinkingMetadata", () => {
    it("removes top-level thoughtSignature", () => {
      const part = {
        thought: true,
        text: "thinking...",
        thoughtSignature: "EsgQCsUQAXLI2ny...",
      };
      const result = stripGeminiThinkingMetadata(part);
      expect(result.part.thoughtSignature).toBeUndefined();
      expect(result.stripped).toBe(1);
      expect(result.part.text).toBe("thinking...");
    });

    it("removes top-level thinkingMetadata", () => {
      const part = {
        text: "response",
        thinkingMetadata: { someData: true },
      };
      const result = stripGeminiThinkingMetadata(part);
      expect(result.part.thinkingMetadata).toBeUndefined();
      expect(result.stripped).toBe(1);
    });

    it("removes nested metadata.google.thoughtSignature", () => {
      const part = {
        functionCall: { name: "bash", args: { command: "df -h" } },
        metadata: {
          google: {
            thoughtSignature: "EsgQCsUQAXLI2ny...",
          },
        },
      };
      const result = stripGeminiThinkingMetadata(part);
      const metadata = result.part.metadata as Record<string, unknown> | undefined;
      const google = metadata?.google as Record<string, unknown> | undefined;
      expect(google?.thoughtSignature).toBeUndefined();
      expect(result.stripped).toBe(1);
    });

    it("preserves non-signature metadata when preserveNonSignature is true", () => {
      const part = {
        functionCall: { name: "bash" },
        metadata: {
          google: {
            thoughtSignature: "sig123",
            groundingMetadata: "preserved",
          },
          cache_control: { type: "ephemeral" },
        },
      };
      const result = stripGeminiThinkingMetadata(part, true);
      const metadata = result.part.metadata as Record<string, unknown> | undefined;
      const google = metadata?.google as Record<string, unknown> | undefined;
      const cacheControl = metadata?.cache_control as Record<string, unknown> | undefined;
      expect(google?.thoughtSignature).toBeUndefined();
      expect(google?.groundingMetadata).toBe("preserved");
      expect(cacheControl?.type).toBe("ephemeral");
    });

    it("cleans up empty google object", () => {
      const part = {
        text: "hello",
        metadata: {
          google: {
            thoughtSignature: "sig123",
          },
        },
      };
      const result = stripGeminiThinkingMetadata(part, true);
      const metadata = result.part.metadata as Record<string, unknown> | undefined;
      const google = metadata?.google as Record<string, unknown> | undefined;
      expect(google).toBeUndefined();
    });

    it("cleans up empty metadata object", () => {
      const part = {
        text: "hello",
        metadata: {
          google: {
            thoughtSignature: "sig123",
          },
        },
      };
      const result = stripGeminiThinkingMetadata(part, true);
      expect(result.part.metadata).toBeUndefined();
    });

    it("handles parts without metadata", () => {
      const part = { text: "Hello" };
      const result = stripGeminiThinkingMetadata(part);
      expect(result.part).toEqual({ text: "Hello" });
      expect(result.stripped).toBe(0);
    });
  });

  describe("stripClaudeThinkingFields", () => {
    it("removes signature from thinking blocks", () => {
      const part = {
        type: "thinking",
        thinking: "Analyzing...",
        signature: "claude-sig-abc123def456...",
      };
      const result = stripClaudeThinkingFields(part);
      expect(result.part.signature).toBeUndefined();
      expect(result.stripped).toBe(1);
      expect(result.part.thinking).toBe("Analyzing...");
    });

    it("removes signature from redacted_thinking blocks", () => {
      const part = {
        type: "redacted_thinking",
        data: "encrypted",
        signature: "a]".repeat(30),
      };
      const result = stripClaudeThinkingFields(part);
      expect(result.part.signature).toBeUndefined();
      expect(result.stripped).toBe(1);
    });

    it("removes long signature from non-thinking parts", () => {
      const part = {
        type: "text",
        text: "hello",
        signature: "a".repeat(60),
      };
      const result = stripClaudeThinkingFields(part);
      expect(result.part.signature).toBeUndefined();
      expect(result.stripped).toBe(1);
    });

    it("preserves short signature-like fields", () => {
      const part = {
        type: "text",
        text: "hello",
        signature: "short",
      };
      const result = stripClaudeThinkingFields(part);
      expect(result.part.signature).toBe("short");
      expect(result.stripped).toBe(0);
    });

    it("handles parts without signature", () => {
      const part = { type: "text", text: "Hello" };
      const result = stripClaudeThinkingFields(part);
      expect(result.part).toEqual({ type: "text", text: "Hello" });
      expect(result.stripped).toBe(0);
    });
  });

  describe("deepSanitizeCrossModelMetadata", () => {
    it("sanitizes contents array (Gemini format)", () => {
      const payload = {
        contents: [
          {
            role: "model",
            parts: [
              {
                thought: true,
                text: "thinking...",
                thoughtSignature: "sig1",
              },
              {
                functionCall: { name: "bash" },
                metadata: { google: { thoughtSignature: "sig2" } },
              },
            ],
          },
        ],
      };

      const result = deepSanitizeCrossModelMetadata(payload, "claude");
      const parts = (result.obj as any).contents[0].parts;

      expect(parts[0].thoughtSignature).toBeUndefined();
      expect(parts[1].metadata?.google?.thoughtSignature).toBeUndefined();
      expect(parts[1].functionCall.name).toBe("bash");
      expect(result.stripped).toBe(2);
    });

    it("sanitizes messages array (Anthropic format)", () => {
      const payload = {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "analyzing...",
                signature: "a".repeat(60),
              },
              { type: "tool_use", id: "tool_1", name: "bash" },
            ],
          },
        ],
      };

      const result = deepSanitizeCrossModelMetadata(payload, "gemini");
      const content = (result.obj as any).messages[0].content;

      expect(content[0].signature).toBeUndefined();
      expect(content[1].name).toBe("bash");
      expect(result.stripped).toBe(1);
    });

    it("sanitizes extra_body.messages", () => {
      const payload = {
        extra_body: {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  metadata: { google: { thoughtSignature: "sig" } },
                },
              ],
            },
          ],
        },
      };

      const result = deepSanitizeCrossModelMetadata(payload, "claude");
      const content = (result.obj as any).extra_body.messages[0].content;

      expect(content[0].metadata?.google?.thoughtSignature).toBeUndefined();
      expect(result.stripped).toBe(1);
    });

    it("handles nested requests array (batch format)", () => {
      const payload = {
        requests: [
          {
            contents: [
              {
                role: "model",
                parts: [{ thoughtSignature: "sig1" }],
              },
            ],
          },
          {
            contents: [
              {
                role: "model",
                parts: [{ thoughtSignature: "sig2" }],
              },
            ],
          },
        ],
      };

      const result = deepSanitizeCrossModelMetadata(payload, "claude");
      expect(result.stripped).toBe(2);
    });
  });

  describe("sanitizeCrossModelPayload", () => {
    it("strips Gemini signatures when target is Claude", () => {
      const payload = {
        contents: [
          {
            role: "model",
            parts: [
              { thought: true, text: "thinking...", thoughtSignature: "sig1" },
              {
                functionCall: { name: "bash" },
                metadata: { google: { thoughtSignature: "sig2" } },
              },
            ],
          },
        ],
      };

      const result = sanitizeCrossModelPayload(payload, {
        targetModel: "claude-opus-4-5-thinking-medium",
      });

      expect(result.modified).toBe(true);
      expect(result.signaturesStripped).toBe(2);
      const parts = (result.payload as any).contents[0].parts;
      expect(parts[0].thoughtSignature).toBeUndefined();
      expect(parts[1].metadata?.google?.thoughtSignature).toBeUndefined();
    });

    it("strips Claude signatures when target is Gemini", () => {
      const payload = {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "analyzing...",
                signature: "a".repeat(60),
              },
            ],
          },
        ],
      };

      const result = sanitizeCrossModelPayload(payload, {
        targetModel: "gemini-3-pro-low",
      });

      expect(result.modified).toBe(true);
      expect(result.signaturesStripped).toBe(1);
    });

    it("skips sanitization for unknown target model", () => {
      const payload = {
        contents: [
          {
            parts: [{ thoughtSignature: "sig" }],
          },
        ],
      };

      const result = sanitizeCrossModelPayload(payload, {
        targetModel: "gpt-4",
      });

      expect(result.modified).toBe(false);
      expect(result.signaturesStripped).toBe(0);
      expect((result.payload as any).contents[0].parts[0].thoughtSignature).toBe("sig");
    });

    it("preserves functionCall structure", () => {
      const payload = {
        contents: [
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "Bash",
                  args: { command: "df -h", description: "Check disk space" },
                },
                metadata: { google: { thoughtSignature: "sig" } },
              },
            ],
          },
        ],
      };

      const result = sanitizeCrossModelPayload(payload, {
        targetModel: "claude-sonnet-4-5-thinking-low",
      });

      const fc = (result.payload as any).contents[0].parts[0].functionCall;
      expect(fc.name).toBe("Bash");
      expect(fc.args.command).toBe("df -h");
    });

    it("preserves non-signature metadata when option is true", () => {
      const payload = {
        contents: [
          {
            parts: [
              {
                functionCall: { name: "read" },
                metadata: {
                  google: {
                    thoughtSignature: "strip-me",
                    groundingMetadata: "keep-me",
                  },
                  cache_control: { type: "ephemeral" },
                },
              },
            ],
          },
        ],
      };

      const result = sanitizeCrossModelPayload(payload, {
        targetModel: "claude-sonnet-4",
        preserveNonSignatureMetadata: true,
      });

      const meta = (result.payload as any).contents[0].parts[0].metadata;
      expect(meta.google.thoughtSignature).toBeUndefined();
      expect(meta.google.groundingMetadata).toBe("keep-me");
      expect(meta.cache_control.type).toBe("ephemeral");
    });
  });

  describe("sanitizeCrossModelPayloadInPlace", () => {
    it("mutates payload directly", () => {
      const payload = {
        contents: [
          {
            parts: [
              {
                thought: true,
                thoughtSignature: "sig",
              },
            ],
          },
        ],
      };

      const stripped = sanitizeCrossModelPayloadInPlace(
        payload as Record<string, unknown>,
        { targetModel: "claude-opus-4-5-thinking-high" }
      );

      expect(stripped).toBe(1);
      expect((payload as any).contents[0].parts[0].thoughtSignature).toBeUndefined();
    });

    it("handles extra_body.messages", () => {
      const payload = {
        extra_body: {
          messages: [
            {
              content: [{ metadata: { google: { thoughtSignature: "sig" } } }],
            },
          ],
        },
      };

      const stripped = sanitizeCrossModelPayloadInPlace(
        payload as Record<string, unknown>,
        { targetModel: "claude-sonnet-4" }
      );

      expect(stripped).toBe(1);
    });
  });

  describe("real-world reproduction scenario", () => {
    it("handles Gemini thinking + tool call -> Claude tool call scenario", () => {
      const geminiSessionHistory = {
        contents: [
          {
            role: "user",
            parts: [
              {
                text: "Check disk space. Think about which filesystems are most utilized.",
              },
            ],
          },
          {
            role: "model",
            parts: [
              {
                thought: true,
                text: "I need to analyze disk usage by running df -h...",
                thoughtSignature:
                  "EsgQCsUQAXLI2nybuafAE150LGTo2r78fakesig123",
              },
              {
                functionCall: {
                  name: "Bash",
                  args: { command: "df -h", description: "Check disk space" },
                },
                metadata: {
                  google: {
                    thoughtSignature:
                      "EsgQCsUQAXLI2nybuafAE150LGTo2r78fakesig123",
                  },
                },
              },
            ],
          },
          {
            role: "function",
            parts: [
              {
                functionResponse: {
                  name: "Bash",
                  response: {
                    output: "Filesystem      Size  Used Avail Use%...",
                  },
                },
              },
            ],
          },
          {
            role: "model",
            parts: [{ text: "The root filesystem is 62% utilized..." }],
          },
          {
            role: "user",
            parts: [{ text: "Now check memory usage with free -h" }],
          },
        ],
      };

      const result = sanitizeCrossModelPayload(geminiSessionHistory, {
        targetModel: "claude-opus-4-5-thinking-medium",
      });

      expect(result.modified).toBe(true);
      expect(result.signaturesStripped).toBe(2);

      const modelParts = (result.payload as any).contents[1].parts;
      expect(modelParts[0].thoughtSignature).toBeUndefined();
      expect(modelParts[0].thought).toBe(true);
      expect(modelParts[0].text).toContain("analyze disk usage");

      expect(modelParts[1].metadata?.google?.thoughtSignature).toBeUndefined();
      expect(modelParts[1].functionCall.name).toBe("Bash");
      expect(modelParts[1].functionCall.args.command).toBe("df -h");

      const functionResponse = (result.payload as any).contents[2].parts[0]
        .functionResponse;
      expect(functionResponse.name).toBe("Bash");
    });

    it("handles Claude thinking + tool use -> Gemini tool call scenario", () => {
      const claudeSessionHistory = {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "List files" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "I should list the files...",
                signature: "a".repeat(100),
              },
              {
                type: "tool_use",
                id: "tool_abc123",
                name: "bash",
                input: { command: "ls -la" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool_abc123",
                content: "file1.txt\nfile2.txt",
              },
            ],
          },
        ],
      };

      const result = sanitizeCrossModelPayload(claudeSessionHistory, {
        targetModel: "gemini-3-flash",
      });

      expect(result.modified).toBe(true);
      expect(result.signaturesStripped).toBe(1);

      const assistantContent = (result.payload as any).messages[1].content;
      expect(assistantContent[0].signature).toBeUndefined();
      expect(assistantContent[0].thinking).toContain("list the files");
      expect(assistantContent[1].name).toBe("bash");
    });
  });
});

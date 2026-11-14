import { describe, expect, it } from "vitest";
import {
  OPENCODE_SIGNATURE_NEEDLE,
  OPENCODE_SIGNATURE_REPLACEMENT,
  sanitizeOpenCodePromptSignatureText,
  sanitizeOpenCodePromptSignatureInPlace,
} from "./prompt-signature";

describe("prompt-signature unit tests", () => {
  describe("sanitizeOpenCodePromptSignatureText", () => {
    it("rewrites the needle to bracket property access", () => {
      const input = "Code Mode tools catalog:\n - tools.opencode.session_move({ ... })";
      const output = sanitizeOpenCodePromptSignatureText(input);

      expect(output).not.toContain(OPENCODE_SIGNATURE_NEEDLE);
      expect(output).toContain('tools["opencode"].session_move({ ... })');
    });

    it("handles multiple occurrences in a single string", () => {
      const input = "tools.opencode.session_move and tools.opencode.worktree_list and tools.opencode.models";
      const output = sanitizeOpenCodePromptSignatureText(input);

      expect(output).not.toContain(OPENCODE_SIGNATURE_NEEDLE);
      expect(output.match(/tools\["opencode"\]\./g)?.length).toBe(3);
    });

    it("leaves strings without the needle unchanged", () => {
      const input = "You are a helpful assistant.";
      expect(sanitizeOpenCodePromptSignatureText(input)).toBe(input);
    });

    it("is idempotent: applying twice does not alter the result further", () => {
      const input = "Use tools.opencode.session_move to move sessions.";
      const once = sanitizeOpenCodePromptSignatureText(input);
      const twice = sanitizeOpenCodePromptSignatureText(once);

      expect(twice).toBe(once);
      expect(twice).toBe('Use tools["opencode"].session_move to move sessions.');
    });

    it("preserves special characters, backslashes, quotes, and unicode", () => {
      const input = 'tools.opencode.session_move with "quotes", \\backslashes\\, and emojis 🚀 \u00A0 \u2024';
      const output = sanitizeOpenCodePromptSignatureText(input);

      expect(output).toBe('tools["opencode"].session_move with "quotes", \\backslashes\\, and emojis 🚀 \u00A0 \u2024');
    });
  });

  describe("sanitizeOpenCodePromptSignatureInPlace", () => {
    it("sanitizes systemInstruction with parts array", () => {
      const req: Record<string, unknown> = {
        systemInstruction: {
          role: "user",
          parts: [
            { text: "Catalog:\n - tools.opencode.session_move()" },
            { text: "Plain text instruction" },
          ],
        },
      };

      sanitizeOpenCodePromptSignatureInPlace(req);

      const sys = req.systemInstruction as any;
      expect(sys.parts[0].text).toBe('Catalog:\n - tools["opencode"].session_move()');
      expect(sys.parts[1].text).toBe("Plain text instruction");
    });

    it("sanitizes string systemInstruction", () => {
      const req: Record<string, unknown> = {
        systemInstruction: "Always use tools.opencode.session_move for directory switches.",
      };

      sanitizeOpenCodePromptSignatureInPlace(req);

      expect(req.systemInstruction).toBe('Always use tools["opencode"].session_move for directory switches.');
    });

    it("sanitizes system_instruction alias if present", () => {
      const req: Record<string, unknown> = {
        system_instruction: {
          parts: [{ text: "tools.opencode.session_move" }],
        },
      };

      sanitizeOpenCodePromptSignatureInPlace(req);

      const sys = req.system_instruction as any;
      expect(sys.parts[0].text).toBe('tools["opencode"].session_move');
    });

    it("sanitizes contents array (Gemini format)", () => {
      const req: Record<string, unknown> = {
        contents: [
          {
            role: "user",
            parts: [{ text: "Look at tools.opencode.session_move documentation" }],
          },
        ],
      };

      sanitizeOpenCodePromptSignatureInPlace(req);

      const contents = req.contents as any[];
      expect(contents[0].parts[0].text).toBe('Look at tools["opencode"].session_move documentation');
    });

    it("sanitizes messages array (Anthropic format)", () => {
      const req: Record<string, unknown> = {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Check tools.opencode.session_move" }],
          },
        ],
      };

      sanitizeOpenCodePromptSignatureInPlace(req);

      const messages = req.messages as any[];
      expect(messages[0].content[0].text).toBe('Check tools["opencode"].session_move');
    });

    it("sanitizes extra_body.messages (Anthropic via providerOptions)", () => {
      const req: Record<string, unknown> = {
        extra_body: {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "See tools.opencode.session_move" }],
            },
          ],
        },
      };

      sanitizeOpenCodePromptSignatureInPlace(req);

      const extra = req.extra_body as any;
      expect(extra.messages[0].content[0].text).toBe('See tools["opencode"].session_move');
    });

    it("leaves requests without the signature completely unchanged", () => {
      const req: Record<string, unknown> = {
        systemInstruction: {
          parts: [{ text: "You are Antigravity, a helpful assistant." }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello world" }],
          },
        ],
      };

      const clone = JSON.parse(JSON.stringify(req));
      sanitizeOpenCodePromptSignatureInPlace(req);

      expect(req).toEqual(clone);
    });

    it("does not mutate tool declarations or function calls", () => {
      const req: Record<string, unknown> = {
        systemInstruction: {
          parts: [{ text: "Use tools.opencode.session_move" }],
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: "execute",
                description: "Execute code. Example: tools.opencode.session_move",
                parameters: { type: "object", properties: { code: { type: "string" } } },
              },
            ],
          },
        ],
      };

      sanitizeOpenCodePromptSignatureInPlace(req);

      // System instruction is neutralized
      const sys = req.systemInstruction as any;
      expect(sys.parts[0].text).toContain('tools["opencode"].session_move');

      // Tools declarations are preserved as-is (filter only targets systemInstruction)
      const tools = req.tools as any[];
      expect(tools[0].functionDeclarations[0].description).toBe("Execute code. Example: tools.opencode.session_move");
    });
  });

  describe("JSON serialization integrity (regression tests for CodeRabbit issue)", () => {
    it("produces valid JSON that passes JSON.parse without error", () => {
      const req: Record<string, unknown> = {
        project: "test-project",
        model: "gemini-3.8-flash-medium",
        request: {
          systemInstruction: {
            role: "user",
            parts: [
              {
                text: 'Code Mode tools catalog:\n - tools.opencode.session_move({\n  directory: string,\n})\n"quoted" and \\escaped\\',
              },
            ],
          },
        },
      };

      // Perform in-place sanitization BEFORE JSON.stringify
      sanitizeOpenCodePromptSignatureInPlace(req.request as Record<string, unknown>);

      // Serialize
      const serialized = JSON.stringify(req);

      // Must be valid JSON
      expect(() => JSON.parse(serialized)).not.toThrow();

      // Must decode properly with escaped double quotes inside the string value
      const parsed = JSON.parse(serialized);
      const decodedText = parsed.request.systemInstruction.parts[0].text;

      expect(decodedText).toContain('tools["opencode"].session_move');
      expect(decodedText).not.toContain(OPENCODE_SIGNATURE_NEEDLE);
      expect(decodedText).toContain('"quoted"');
      expect(decodedText).toContain("\\escaped\\");
    });

    it("serializes multiple occurrences across systemInstruction and contents with valid JSON", () => {
      const req: Record<string, unknown> = {
        request: {
          systemInstruction: {
            parts: [
              { text: "Catalog item 1: tools.opencode.session_move" },
              { text: "Catalog item 2: tools.opencode.worktree_create" },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: "Please call tools.opencode.session_move" }],
            },
          ],
        },
      };

      sanitizeOpenCodePromptSignatureInPlace(req.request as Record<string, unknown>);

      const serialized = JSON.stringify(req);
      const parsed = JSON.parse(serialized);

      expect(parsed.request.systemInstruction.parts[0].text).toBe('Catalog item 1: tools["opencode"].session_move');
      expect(parsed.request.systemInstruction.parts[1].text).toBe('Catalog item 2: tools["opencode"].worktree_create');
      expect(parsed.request.contents[0].parts[0].text).toBe('Please call tools["opencode"].session_move');
    });
  });
});

import { describe, it, expect } from "vitest";
import { fixDcpSyntheticMessages } from "./compat";

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface Message {
  role: string;
  content: ContentBlock[] | string;
  model?: string;
  stop_reason?: string;
}

describe("DCP Compatibility", () => {
  describe("fixDcpSyntheticMessages", () => {
    it("returns empty array for empty input", () => {
      expect(fixDcpSyntheticMessages([])).toEqual([]);
    });

    it("passes through non-assistant messages unchanged", () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "system", content: "system prompt" },
      ];
      expect(fixDcpSyntheticMessages(messages)).toEqual(messages);
    });

    it("passes through assistant messages that already have thinking block", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "some thought" },
            { type: "text", text: "response" },
          ],
        },
      ];
      expect(fixDcpSyntheticMessages(messages)).toEqual(messages);
    });

    it("passes through assistant messages with redacted_thinking block", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "abc123" },
            { type: "text", text: "response" },
          ],
        },
      ];
      expect(fixDcpSyntheticMessages(messages)).toEqual(messages);
    });

    it("injects redacted_thinking for assistant message starting with text", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [{ type: "text", text: "DCP synthetic message" }],
        },
      ];
      const result = fixDcpSyntheticMessages(messages) as Message[];

      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("assistant");
      const content = result[0].content as ContentBlock[];
      expect(content).toHaveLength(2);
      expect(content[0].type).toBe("redacted_thinking");
      expect(content[1].type).toBe("text");
    });

    it("injects redacted_thinking for assistant message starting with tool_use", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool_1", name: "bash", input: {} },
          ],
        },
      ];
      const result = fixDcpSyntheticMessages(messages) as Message[];
      const content = result[0].content as ContentBlock[];

      expect(content[0].type).toBe("redacted_thinking");
      expect(content[1].type).toBe("tool_use");
    });

    it("handles multiple assistant messages correctly", () => {
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "needs fix" }],
        },
        { role: "user", content: [{ type: "text", text: "q2" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "already has" },
            { type: "text", text: "ok" },
          ],
        },
      ];

      const result = fixDcpSyntheticMessages(messages) as Message[];
      const content1 = result[1].content as ContentBlock[];
      const content3 = result[3].content as ContentBlock[];

      expect(content1[0].type).toBe("redacted_thinking");
      expect(content1[1].type).toBe("text");
      expect(content3[0].type).toBe("thinking");
    });

    it("handles assistant message with empty content array", () => {
      const messages: Message[] = [{ role: "assistant", content: [] }];
      expect(fixDcpSyntheticMessages(messages)).toEqual(messages);
    });

    it("handles assistant message with string content", () => {
      const messages: Message[] = [{ role: "assistant", content: "string content" }];
      expect(fixDcpSyntheticMessages(messages)).toEqual(messages);
    });

    it("preserves other message properties", () => {
      const messages: Message[] = [
        {
          role: "assistant",
          content: [{ type: "text", text: "test" }],
          model: "claude-3",
          stop_reason: "end_turn",
        },
      ];
      const result = fixDcpSyntheticMessages(messages) as Message[];

      expect(result[0].model).toBe("claude-3");
      expect(result[0].stop_reason).toBe("end_turn");
    });
  });
});

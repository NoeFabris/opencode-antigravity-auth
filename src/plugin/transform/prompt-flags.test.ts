import { describe, it, expect } from "vitest"
import { parsePromptFlags, extractLastUserPrompt } from "./prompt-flags.ts"

describe("transform/prompt-flags", () => {
  describe("parsePromptFlags", () => {
    it("returns prompt unchanged when no flags present", () => {
      const result = parsePromptFlags("一個坐在窗邊的寫實動物，柔和街燈，柔焦")
      expect(result.cleanedPrompt).toBe("一個坐在窗邊的寫實動物，柔和街燈，柔焦")
      expect(result.resolution).toBeUndefined()
      expect(result.aspectRatio).toBeUndefined()
    })

    it("extracts --resolution=4K and strips from prompt", () => {
      const result = parsePromptFlags("a cat --resolution=4K sitting by a window")
      expect(result.resolution).toBe("4K")
      expect(result.cleanedPrompt).toBe("a cat sitting by a window")
    })

    it("extracts --aspect-ratio=16:9 and strips from prompt", () => {
      const result = parsePromptFlags("mountain landscape --aspect-ratio=16:9")
      expect(result.aspectRatio).toBe("16:9")
      expect(result.cleanedPrompt).toBe("mountain landscape")
    })

    it("extracts both flags simultaneously", () => {
      const result = parsePromptFlags("sunset beach --resolution=2K --aspect-ratio=9:16")
      expect(result.resolution).toBe("2K")
      expect(result.aspectRatio).toBe("9:16")
      expect(result.cleanedPrompt).toBe("sunset beach")
    })

    it("handles flags at the start of prompt", () => {
      const result = parsePromptFlags("--resolution=4K a beautiful forest")
      expect(result.resolution).toBe("4K")
      expect(result.cleanedPrompt).toBe("a beautiful forest")
    })

    it("handles flags at the end of prompt", () => {
      const result = parsePromptFlags("a beautiful forest --resolution=4K")
      expect(result.resolution).toBe("4K")
      expect(result.cleanedPrompt).toBe("a beautiful forest")
    })

    it("handles lowercase resolution value", () => {
      const result = parsePromptFlags("a cat --resolution=4k")
      expect(result.resolution).toBe("4k")
      // Note: normalization to uppercase is handled by buildImageGenerationConfig, not here
    })

    it("handles 0.5K resolution", () => {
      const result = parsePromptFlags("quick sketch --resolution=0.5K")
      expect(result.resolution).toBe("0.5K")
    })

    it("handles quoted values with double quotes", () => {
      const result = parsePromptFlags('a cat --aspect-ratio="16:9"')
      expect(result.aspectRatio).toBe("16:9")
    })

    it("handles quoted values with single quotes", () => {
      const result = parsePromptFlags("a cat --aspect-ratio='16:9'")
      expect(result.aspectRatio).toBe("16:9")
    })

    it("handles space-separated flag values", () => {
      const result = parsePromptFlags("a cat --resolution 4K")
      expect(result.resolution).toBe("4K")
      expect(result.cleanedPrompt).toBe("a cat")
    })

    it("handles mixed Chinese and English with flags", () => {
      const result = parsePromptFlags("一個寫實貓 --resolution=4K --aspect-ratio=1:1 sitting by window")
      expect(result.resolution).toBe("4K")
      expect(result.aspectRatio).toBe("1:1")
      expect(result.cleanedPrompt).toBe("一個寫實貓 sitting by window")
    })

    it("collapses multiple spaces after flag removal", () => {
      const result = parsePromptFlags("a cat  --resolution=4K  sitting")
      expect(result.resolution).toBe("4K")
      expect(result.cleanedPrompt).not.toContain("  ")
    })

    it("trims whitespace from cleaned prompt", () => {
      const result = parsePromptFlags("  --resolution=4K a cat  ")
      expect(result.resolution).toBe("4K")
      expect(result.cleanedPrompt).toBe("a cat")
    })

    it("handles extended aspect ratios for flash models", () => {
      const result = parsePromptFlags("tall banner --aspect-ratio=4:1")
      expect(result.aspectRatio).toBe("4:1")
    })

    it("handles empty prompt with only flags", () => {
      const result = parsePromptFlags("--resolution=2K --aspect-ratio=1:1")
      expect(result.resolution).toBe("2K")
      expect(result.aspectRatio).toBe("1:1")
      expect(result.cleanedPrompt).toBe("")
    })

    it("is case-insensitive for flag names", () => {
      const result = parsePromptFlags("a cat --Resolution=4K --Aspect-Ratio=16:9")
      expect(result.resolution).toBe("4K")
      expect(result.aspectRatio).toBe("16:9")
    })

    it("only extracts the first occurrence of each flag", () => {
      const result = parsePromptFlags("a cat --resolution=4K --resolution=2K")
      expect(result.resolution).toBe("4K")
    })
  })

  describe("extractLastUserPrompt", () => {
    it("returns undefined for empty array", () => {
      expect(extractLastUserPrompt([])).toBeUndefined()
    })

    it("returns undefined for non-array input", () => {
      expect(extractLastUserPrompt(null as any)).toBeUndefined()
    })

    it("returns undefined when no user messages exist", () => {
      const contents = [
        { role: "model", parts: [{ text: "Hello" }] },
      ]
      expect(extractLastUserPrompt(contents)).toBeUndefined()
    })

    it("extracts text from single user message", () => {
      const contents = [
        { role: "user", parts: [{ text: "draw a cat" }] },
      ]
      const result = extractLastUserPrompt(contents)
      expect(result).toBeDefined()
      expect(result!.text).toBe("draw a cat")
      expect(result!.contentIndex).toBe(0)
      expect(result!.partIndex).toBe(0)
    })

    it("returns the last user message when multiple exist", () => {
      const contents = [
        { role: "user", parts: [{ text: "first message" }] },
        { role: "model", parts: [{ text: "response" }] },
        { role: "user", parts: [{ text: "draw a cat --resolution=4K" }] },
      ]
      const result = extractLastUserPrompt(contents)
      expect(result).toBeDefined()
      expect(result!.text).toBe("draw a cat --resolution=4K")
      expect(result!.contentIndex).toBe(2)
    })

    it("finds the last text part in a multi-part user message", () => {
      const contents = [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data: "base64" } },
            { text: "describe this --resolution=4K" },
          ],
        },
      ]
      const result = extractLastUserPrompt(contents)
      expect(result).toBeDefined()
      expect(result!.text).toBe("describe this --resolution=4K")
      expect(result!.partIndex).toBe(1)
    })

    it("skips user messages with no text parts", () => {
      const contents = [
        { role: "user", parts: [{ text: "earlier prompt" }] },
        { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "base64" } }] },
      ]
      const result = extractLastUserPrompt(contents)
      expect(result).toBeDefined()
      expect(result!.text).toBe("earlier prompt")
      expect(result!.contentIndex).toBe(0)
    })

    it("skips empty text parts", () => {
      const contents = [
        { role: "user", parts: [{ text: "real content" }, { text: "" }] },
      ]
      const result = extractLastUserPrompt(contents)
      expect(result).toBeDefined()
      expect(result!.text).toBe("real content")
    })

    it("handles missing parts array", () => {
      const contents = [
        { role: "user" },
      ]
      expect(extractLastUserPrompt(contents)).toBeUndefined()
    })
  })
})

/**
 * Prompt Flag Parser
 *
 * Extracts --resolution and --aspect-ratio flags from image generation prompts.
 * Flags are stripped from the prompt text before sending to Gemini so the model
 * only sees the clean image description.
 *
 * Supported flags:
 *   --resolution=4K      -> maps to imageSize (valid: 0.5K, 1K, 2K, 4K)
 *   --aspect-ratio=16:9  -> maps to aspectRatio (valid depends on model)
 */

/**
 * Result of parsing prompt flags.
 */
export interface ParsedPromptFlags {
  /** The prompt text with flags stripped out */
  cleanedPrompt: string
  /** Extracted --resolution value (e.g., "4K"), or undefined if not specified */
  resolution?: string
  /** Extracted --aspect-ratio value (e.g., "16:9"), or undefined if not specified */
  aspectRatio?: string
}

/**
 * Regex patterns for supported flags.
 * Matches both --flag=value and --flag value formats.
 * Values can be optionally quoted with single or double quotes.
 */
const RESOLUTION_PATTERN = /--resolution[=\s]+["']?([^\s"']+)["']?/gi
const ASPECT_RATIO_PATTERN = /--aspect-ratio[=\s]+["']?([^\s"']+)["']?/gi

/**
 * Parse prompt flags from text and return cleaned prompt + extracted values.
 *
 * @param prompt - The raw prompt text that may contain flags
 * @returns Parsed result with cleaned prompt and extracted flag values
 */
export function parsePromptFlags(prompt: string): ParsedPromptFlags {
  const result: ParsedPromptFlags = {
    cleanedPrompt: prompt,
  }

  // Extract --resolution
  const resolutionMatch = RESOLUTION_PATTERN.exec(prompt)
  if (resolutionMatch?.[1]) {
    result.resolution = resolutionMatch[1]
  }
  // Reset lastIndex for global regex
  RESOLUTION_PATTERN.lastIndex = 0

  // Extract --aspect-ratio
  const aspectRatioMatch = ASPECT_RATIO_PATTERN.exec(prompt)
  if (aspectRatioMatch?.[1]) {
    result.aspectRatio = aspectRatioMatch[1]
  }
  ASPECT_RATIO_PATTERN.lastIndex = 0

  // Strip all flag occurrences from prompt
  let cleaned = prompt
    .replace(RESOLUTION_PATTERN, "")
    .replace(ASPECT_RATIO_PATTERN, "")
    .replace(/\s{2,}/g, " ")
    .trim()

  // Reset lastIndex after replace
  RESOLUTION_PATTERN.lastIndex = 0
  ASPECT_RATIO_PATTERN.lastIndex = 0

  result.cleanedPrompt = cleaned

  return result
}

/**
 * Extract the last user message text from a Gemini contents array.
 * Used to find flags in the most recent user prompt.
 *
 * @param contents - The Gemini-format contents array
 * @returns The text of the last user message, or undefined if not found
 */
export function extractLastUserPrompt(contents: unknown[]): { text: string, contentIndex: number, partIndex: number } | undefined {
  if (!Array.isArray(contents)) {
    return undefined
  }

  // Walk backwards to find the last user message
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i] as Record<string, unknown> | undefined
    if (!content || content.role !== "user") {
      continue
    }

    const parts = content.parts as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(parts)) {
      continue
    }

    // Find the last text part in this user message
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if (part && typeof part.text === "string" && part.text.trim().length > 0) {
        return { text: part.text, contentIndex: i, partIndex: j }
      }
    }
  }

  return undefined
}

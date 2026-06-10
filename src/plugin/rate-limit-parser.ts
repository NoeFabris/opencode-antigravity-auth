/**
 * Rate Limit Parser for Antigravity Cloud Code API.
 *
 * Parses reset times from HTTP 429 response headers and error message bodies.
 * Based on the official CLI's error format: quotaResetDelay, quotaResetTimeStamp,
 * retry-after-ms. Matches the antigravity-claude-proxy reference implementation.
 */

/**
 * Parse reset time in milliseconds from an HTTP Response or error.
 * Checks headers first (Retry-After, x-ratelimit-reset), then body
 * (quotaResetDelay, quotaResetTimeStamp, retry-after-ms, duration strings).
 */
export function parseRateLimitResetMs(responseOrBody: Response | string): number | null {
  let resetMs: number | null = null

  // Phase 1: Check response headers
  if (typeof responseOrBody !== "string" && responseOrBody.headers) {
    const headers = responseOrBody.headers

    const retryAfter = headers.get("retry-after")
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10)
      if (!isNaN(seconds)) {
        resetMs = seconds * 1000
      } else {
        const date = new Date(retryAfter)
        if (!isNaN(date.getTime())) {
          resetMs = date.getTime() - Date.now()
          if (resetMs <= 0) resetMs = null
        }
      }
    }

    if (!resetMs) {
      const ratelimitReset = headers.get("x-ratelimit-reset")
      if (ratelimitReset) {
        const resetTimestamp = parseInt(ratelimitReset, 10) * 1000
        resetMs = resetTimestamp - Date.now()
        if (resetMs <= 0) resetMs = null
      }
    }

    if (!resetMs) {
      const resetAfter = headers.get("x-ratelimit-reset-after")
      if (resetAfter) {
        const seconds = parseInt(resetAfter, 10)
        if (!isNaN(seconds) && seconds > 0) {
          resetMs = seconds * 1000
        }
      }
    }
  }

  // Phase 2: Parse from error body text
  const bodyText = typeof responseOrBody === "string"
    ? responseOrBody
    : ""

  if (!resetMs && bodyText) {
    // quotaResetDelay: "754.431528ms" or "1.5s"
    const quotaDelayMatch = bodyText.match(/quotaResetDelay[:\s"]+(\d+(?:\.\d+)?)(ms|s)/i)
    if (quotaDelayMatch) {
      const value = parseFloat(quotaDelayMatch[1]!)
      const unit = quotaDelayMatch[2]!.toLowerCase()
      resetMs = unit === "s" ? Math.ceil(value * 1000) : Math.ceil(value)
    }

    // quotaResetTimeStamp: ISO format "2025-12-31T07:00:47Z"
    if (!resetMs) {
      const quotaTimestampMatch = bodyText.match(/quotaResetTimeStamp[:\s"]+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i)
      if (quotaTimestampMatch) {
        const resetTime = new Date(quotaTimestampMatch[1]!).getTime()
        if (!isNaN(resetTime)) {
          resetMs = resetTime - Date.now()
        }
      }
    }

    // retry-after-ms or retryDelay in seconds: "7739.23s"
    if (!resetMs) {
      const secMatch = bodyText.match(/(?:retry[-_]?after[-_]?ms|retryDelay)[:\s"]+([\d.]+)(?:s\b|s")/i)
      if (secMatch) {
        resetMs = Math.ceil(parseFloat(secMatch[1]!) * 1000)
      }
    }

    // retry-after-ms explicit: "retry-after-ms: 5000"
    if (!resetMs) {
      const msMatch = bodyText.match(/(?:retry[-_]?after[-_]?ms|retryDelay)[:\s"]+(\d+)(?:\s*ms)?(?![\w.])/i)
      if (msMatch) {
        resetMs = parseInt(msMatch[1]!, 10)
      }
    }

    // Plain seconds: "retry after 60 seconds"
    if (!resetMs) {
      const secMatch = bodyText.match(/retry\s+(?:after\s+)?(\d+)\s*(?:sec|s\b)/i)
      if (secMatch) {
        resetMs = parseInt(secMatch[1]!, 10) * 1000
      }
    }

    // Duration: "1h23m45s" or "23m45s" or "45s"
    if (!resetMs) {
      const durationMatch = bodyText.match(/(\d+)h(\d+)m(\d+)s|(\d+)m(\d+)s|(\d+)s/i)
      if (durationMatch) {
        if (durationMatch[1]) {
          resetMs = (parseInt(durationMatch[1]!, 10) * 3600 + parseInt(durationMatch[2]!, 10) * 60 + parseInt(durationMatch[3]!, 10)) * 1000
        } else if (durationMatch[4]) {
          resetMs = (parseInt(durationMatch[4]!, 10) * 60 + parseInt(durationMatch[5]!, 10)) * 1000
        } else if (durationMatch[6]) {
          resetMs = parseInt(durationMatch[6]!, 10) * 1000
        }
      }
    }
  }

  // Sanity: negative/zero → 500ms minimum
  if (resetMs !== null && resetMs <= 0) {
    resetMs = 500
  }

  return resetMs
}

/**
 * Classify rate limit reason from error body text and HTTP status.
 * Used for smart backoff strategy selection.
 */
export type RateLimitReason =
  | "RATE_LIMIT_EXCEEDED"
  | "QUOTA_EXHAUSTED"
  | "MODEL_CAPACITY_EXHAUSTED"
  | "SERVER_ERROR"
  | "UNKNOWN"

export function parseRateLimitReason(errorText: string, status?: number): RateLimitReason {
  if (status === 529 || status === 503) return "MODEL_CAPACITY_EXHAUSTED"
  if (status === 500) return "SERVER_ERROR"

  const lower = errorText.toLowerCase()

  if (
    lower.includes("quota_exhausted") ||
    lower.includes("quotaresetdelay") ||
    lower.includes("quotaresettimestamp") ||
    lower.includes("resource_exhausted") ||
    lower.includes("daily limit") ||
    lower.includes("quota exceeded")
  ) {
    return "QUOTA_EXHAUSTED"
  }

  if (
    lower.includes("model_capacity_exhausted") ||
    lower.includes("capacity_exhausted") ||
    lower.includes("model is currently overloaded") ||
    lower.includes("service temporarily unavailable")
  ) {
    return "MODEL_CAPACITY_EXHAUSTED"
  }

  if (
    lower.includes("rate_limit_exceeded") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("throttl")
  ) {
    return "RATE_LIMIT_EXCEEDED"
  }

  if (
    lower.includes("internal server error") ||
    lower.includes("server error") ||
    lower.includes("503") ||
    lower.includes("502") ||
    lower.includes("504")
  ) {
    return "SERVER_ERROR"
  }

  return "UNKNOWN"
}

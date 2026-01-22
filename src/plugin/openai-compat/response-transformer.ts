/**
 * Response Transformer: Antigravity/Google Format → OpenAI Chat Completions
 * 
 * Ported from antigravity-claude-proxy src/format/response-converter.js
 */

import type {
  OpenAIChatResponse,
  OpenAIChoice,
  OpenAIResponseMessage,
  OpenAIToolCall,
  OpenAIUsage,
  AntigravityResponse,
  AntigravityCandidate,
  AntigravityPart,
} from './types.js';

/**
 * Generate a unique response ID
 */
function generateResponseId(): string {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Convert Antigravity finish reason to OpenAI format
 */
function convertFinishReason(
  finishReason: string | undefined
): OpenAIChoice['finish_reason'] {
  switch (finishReason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'TOOL_USE':
      return 'tool_calls';
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/**
 * Extract text content from Antigravity parts
 */
function extractTextContent(parts: AntigravityPart[] | undefined): string {
  if (!parts) return '';
  
  return parts
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join('');
}

/**
 * Extract thinking content from Antigravity parts (Claude extended thinking)
 */
function extractThinkingContent(parts: AntigravityPart[] | undefined): string | undefined {
  if (!parts) return undefined;
  
  const thinkingParts = parts
    .filter((part) => part.thought && part.text)
    .map((part) => part.text);
  
  return thinkingParts.length > 0 ? thinkingParts.join('') : undefined;
}

/**
 * Extract tool calls from Antigravity parts
 */
function extractToolCalls(parts: AntigravityPart[] | undefined): OpenAIToolCall[] | undefined {
  if (!parts) return undefined;
  
  const toolCalls: OpenAIToolCall[] = [];
  
  for (const part of parts) {
    if (part.functionCall) {
      toolCalls.push({
        id: part.functionCall.id || `call_${Math.random().toString(36).substring(2, 11)}`,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
    }
  }
  
  return toolCalls.length > 0 ? toolCalls : undefined;
}

/**
 * Convert Antigravity usage to OpenAI format
 */
function convertUsage(
  usageMetadata: AntigravityResponse['usageMetadata']
): OpenAIUsage | undefined {
  if (!usageMetadata) return undefined;
  
  const promptTokens = (usageMetadata.promptTokenCount || 0) - 
                       (usageMetadata.cachedContentTokenCount || 0);
  const completionTokens = usageMetadata.candidatesTokenCount || 0;
  
  return {
    prompt_tokens: Math.max(0, promptTokens),
    completion_tokens: completionTokens,
    total_tokens: Math.max(0, promptTokens) + completionTokens,
  };
}

/**
 * Convert a single Antigravity candidate to OpenAI choice
 */
function convertCandidate(
  candidate: AntigravityCandidate,
  index: number
): OpenAIChoice {
  const parts = candidate.content?.parts;
  const textContent = extractTextContent(parts);
  const thinkingContent = extractThinkingContent(parts);
  const toolCalls = extractToolCalls(parts);
  
  const message: OpenAIResponseMessage = {
    role: 'assistant',
    content: textContent || null,
  };
  
  if (toolCalls) {
    message.tool_calls = toolCalls;
  }
  
  if (thinkingContent) {
    message.thinking = thinkingContent;
  }
  
  return {
    index,
    message,
    finish_reason: convertFinishReason(candidate.finishReason),
    logprobs: null,
  };
}

/**
 * Main transformer: Antigravity Response → OpenAI Chat Response
 */
export function transformAntigravityToOpenAI(
  response: AntigravityResponse,
  model: string
): OpenAIChatResponse {
  const choices: OpenAIChoice[] = [];
  
  if (response.candidates) {
    for (let i = 0; i < response.candidates.length; i++) {
      const candidate = response.candidates[i];
      if (candidate) {
        choices.push(convertCandidate(candidate, i));
      }
    }
  }
  
  // Ensure at least one choice with empty content if no candidates
  if (choices.length === 0) {
    choices.push({
      index: 0,
      message: {
        role: 'assistant',
        content: '',
      },
      finish_reason: 'stop',
      logprobs: null,
    });
  }
  
  return {
    id: generateResponseId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.modelVersion || model,
    choices,
    usage: convertUsage(response.usageMetadata),
  };
}

/**
 * Transform Antigravity error to OpenAI error format
 */
export function transformAntigravityError(
  error: { status?: number; message?: string; reason?: string },
  convert429to400: boolean = true
): { status: number; body: Record<string, unknown> } {
  const status = error.status || 500;
  const message = error.message || error.reason || 'An error occurred';
  
  // Convert 429 to 400 to prevent SDK retry loops
  const responseStatus = (status === 429 && convert429to400) ? 400 : status;
  
  let errorType: string;
  switch (status) {
    case 401:
      errorType = 'authentication_error';
      break;
    case 429:
      errorType = convert429to400 ? 'invalid_request_error' : 'rate_limit_error';
      break;
    case 400:
      errorType = 'invalid_request_error';
      break;
    default:
      errorType = 'api_error';
  }
  
  return {
    status: responseStatus,
    body: {
      error: {
        message,
        type: errorType,
        param: null,
        code: error.reason || null,
      },
    },
  };
}

/**
 * OpenAI Chat Completions API types
 * Used for transforming between OpenAI and Antigravity formats
 */

// ============================================================================
// OpenAI Request Types
// ============================================================================

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[];
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  // Extended thinking support (Claude-specific via OpenAI compat)
  thinking?: {
    type: 'enabled';
    budget_tokens?: number;
  };
}

// ============================================================================
// OpenAI Response Types
// ============================================================================

export interface OpenAIChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
  system_fingerprint?: string;
}

export interface OpenAIChoice {
  index: number;
  message: OpenAIResponseMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  logprobs?: null;
}

export interface OpenAIResponseMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  // Extended thinking (Claude-specific)
  thinking?: string;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ============================================================================
// OpenAI Streaming Types
// ============================================================================

export interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
  usage?: OpenAIUsage | null;
}

export interface OpenAIStreamChoice {
  index: number;
  delta: OpenAIStreamDelta;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  logprobs?: null;
}

export interface OpenAIStreamDelta {
  role?: 'assistant';
  content?: string | null;
  tool_calls?: OpenAIStreamToolCall[];
  // Extended thinking (Claude-specific)
  thinking?: string;
}

/**
 * Streaming tool call with index for delta updates
 */
export interface OpenAIStreamToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

// ============================================================================
// OpenAI Error Types
// ============================================================================

export interface OpenAIError {
  error: {
    message: string;
    type: 'invalid_request_error' | 'rate_limit_error' | 'api_error' | 'authentication_error';
    param?: string | null;
    code?: string | null;
  };
}

// ============================================================================
// Antigravity/Google Format Types (for reference in transformers)
// ============================================================================

export interface AntigravityContent {
  role: 'user' | 'model';
  parts: AntigravityPart[];
}

export interface AntigravityPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
    id?: string;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
    id?: string;
  };
  thought?: boolean;
  thoughtSignature?: string;
}

export interface AntigravityRequest {
  contents: AntigravityContent[];
  systemInstruction?: {
    parts: { text: string }[];
  };
  tools?: AntigravityTool[];
  toolConfig?: {
    functionCallingConfig?: {
      mode: 'NONE' | 'AUTO' | 'ANY';
      allowedFunctionNames?: string[];
    };
  };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    thinkingConfig?: {
      includeThoughts?: boolean;
      thinkingBudget?: number;
    };
  };
}

export interface AntigravityTool {
  functionDeclarations?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }[];
}

export interface AntigravityResponse {
  candidates?: AntigravityCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
}

export interface AntigravityCandidate {
  content?: AntigravityContent;
  finishReason?: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER' | 'TOOL_USE';
  index?: number;
  safetyRatings?: unknown[];
}

// ============================================================================
// Detection Helpers
// ============================================================================

/**
 * Check if a request is in OpenAI Chat Completions format
 */
export function isOpenAIRequest(body: unknown): body is OpenAIChatRequest {
  if (!body || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  
  // Must have messages array
  if (!Array.isArray(obj.messages)) return false;
  if (obj.messages.length === 0) return false;
  
  // Check first message has OpenAI shape (role + content)
  const firstMsg = obj.messages[0] as Record<string, unknown>;
  if (!firstMsg || typeof firstMsg !== 'object') return false;
  if (!('role' in firstMsg)) return false;
  
  // OpenAI uses 'system', 'user', 'assistant', 'tool' roles
  const validRoles = ['system', 'user', 'assistant', 'tool'];
  if (!validRoles.includes(firstMsg.role as string)) return false;
  
  // Antigravity uses 'contents' not 'messages'
  if ('contents' in obj) return false;
  
  return true;
}

/**
 * Check if a request is in Antigravity/Google format
 */
export function isAntigravityRequest(body: unknown): body is AntigravityRequest {
  if (!body || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  
  // Antigravity uses 'contents' array
  if (!Array.isArray(obj.contents)) return false;
  
  return true;
}

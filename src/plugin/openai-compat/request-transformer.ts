/**
 * Request Transformer: OpenAI Chat Completions → Antigravity/Google Format
 * 
 * Ported from antigravity-claude-proxy src/format/request-converter.js
 */

import type {
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAIContentPart,
  OpenAITool,
  AntigravityRequest,
  AntigravityContent,
  AntigravityPart,
  AntigravityTool,
} from './types.js';

/**
 * Convert OpenAI role to Antigravity role
 */
function convertRole(role: string): 'user' | 'model' {
  return role === 'assistant' ? 'model' : 'user';
}

/**
 * Convert OpenAI content to Antigravity parts
 */
function convertContentToParts(
  content: string | OpenAIContentPart[] | undefined,
  role: string,
  message: OpenAIMessage
): AntigravityPart[] {
  const parts: AntigravityPart[] = [];

  // Handle tool calls from assistant
  if (role === 'assistant' && message.tool_calls) {
    for (const toolCall of message.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        // If parsing fails, use empty args
        args = {};
      }
      parts.push({
        functionCall: {
          name: toolCall.function.name,
          args,
          id: toolCall.id,
        },
      });
    }
  }

  // Handle tool results
  if (role === 'tool' && message.tool_call_id) {
    let response: Record<string, unknown> = {};
    if (typeof content === 'string') {
      try {
        response = JSON.parse(content);
      } catch {
        response = { result: content };
      }
    }
    parts.push({
      functionResponse: {
        name: message.name || 'unknown',
        response,
        id: message.tool_call_id,
      },
    });
    return parts;
  }

  // Handle string content
  if (typeof content === 'string') {
    if (content.trim()) {
      parts.push({ text: content });
    }
    return parts;
  }

  // Handle array content (multimodal)
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'text' && part.text) {
        parts.push({ text: part.text });
      } else if (part.type === 'image_url' && part.image_url) {
        // Convert image URL to inline data
        const url = part.image_url.url;
        if (url.startsWith('data:')) {
          // Extract base64 data from data URL
          const matches = url.match(/^data:([^;]+);base64,(.+)$/);
          if (matches && matches[1] && matches[2]) {
            parts.push({
              inlineData: {
                mimeType: matches[1],
                data: matches[2],
              },
            });
          }
        } else {
          // For regular URLs, we'd need to fetch - for now, add as text note
          parts.push({ text: `[Image: ${url}]` });
        }
      }
    }
  }

  return parts;
}

/**
 * Convert OpenAI tools to Antigravity function declarations
 */
function convertTools(tools: OpenAITool[] | undefined): AntigravityTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const functionDeclarations = tools
    .filter((tool) => tool.type === 'function')
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: sanitizeSchema(tool.function.parameters),
    }));

  if (functionDeclarations.length === 0) return undefined;

  return [{ functionDeclarations }];
}

/**
 * Sanitize JSON Schema for Antigravity API
 * Removes unsupported properties like 'default', 'examples', etc.
 */
function sanitizeSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!schema) return undefined;

  const sanitized: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(schema)) {
    // Skip unsupported schema properties
    if (['default', 'examples', '$schema', '$id', 'definitions', '$defs'].includes(key)) {
      continue;
    }

    if (key === 'properties' && typeof value === 'object' && value !== null) {
      // Recursively sanitize property schemas
      const props: Record<string, unknown> = {};
      for (const [propKey, propValue] of Object.entries(value as Record<string, unknown>)) {
        props[propKey] = sanitizeSchema(propValue as Record<string, unknown>);
      }
      sanitized[key] = props;
    } else if (key === 'items' && typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeSchema(value as Record<string, unknown>);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeSchema(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Convert tool_choice to Antigravity toolConfig
 */
function convertToolChoice(
  toolChoice: OpenAIChatRequest['tool_choice']
): AntigravityRequest['toolConfig'] | undefined {
  if (!toolChoice) return undefined;

  if (toolChoice === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } };
  }
  if (toolChoice === 'auto') {
    return { functionCallingConfig: { mode: 'AUTO' } };
  }
  if (toolChoice === 'required') {
    return { functionCallingConfig: { mode: 'ANY' } };
  }
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [toolChoice.function.name],
      },
    };
  }

  return undefined;
}

/**
 * Main transformer: OpenAI Chat Request → Antigravity Request
 */
export function transformOpenAIToAntigravity(request: OpenAIChatRequest): AntigravityRequest {
  const result: AntigravityRequest = {
    contents: [],
  };

  // Extract system message
  const systemMessages = request.messages.filter((m) => m.role === 'system');
  if (systemMessages.length > 0) {
    const systemText = systemMessages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .filter(Boolean)
      .join('\n\n');

    if (systemText) {
      result.systemInstruction = {
        parts: [{ text: systemText }],
      };
    }
  }

  // Convert non-system messages
  const nonSystemMessages = request.messages.filter((m) => m.role !== 'system');
  
  // Group consecutive messages by role and merge tool messages with preceding user
  let currentContent: AntigravityContent | null = null;
  
  for (const message of nonSystemMessages) {
    const antigravityRole = convertRole(message.role);
    const parts = convertContentToParts(message.content, message.role, message);

    // Tool messages should be merged into previous content as functionResponse
    if (message.role === 'tool') {
      if (currentContent && currentContent.role === 'user') {
        currentContent.parts.push(...parts);
      } else {
        // Create new user content for tool response
        currentContent = { role: 'user', parts };
        result.contents.push(currentContent);
      }
      continue;
    }

    // Check if we can merge with current content
    if (currentContent && currentContent.role === antigravityRole) {
      currentContent.parts.push(...parts);
    } else {
      // Start new content block
      if (parts.length > 0) {
        currentContent = { role: antigravityRole, parts };
        result.contents.push(currentContent);
      }
    }
  }

  // Convert tools
  const tools = convertTools(request.tools);
  if (tools) {
    result.tools = tools;
  }

  // Convert tool choice
  const toolConfig = convertToolChoice(request.tool_choice);
  if (toolConfig) {
    result.toolConfig = toolConfig;
  }

  // Convert generation config
  const generationConfig: NonNullable<AntigravityRequest['generationConfig']> = {};
  
  if (request.temperature !== undefined) {
    generationConfig.temperature = request.temperature;
  }
  if (request.top_p !== undefined) {
    generationConfig.topP = request.top_p;
  }
  if (request.max_tokens !== undefined) {
    generationConfig.maxOutputTokens = request.max_tokens;
  }
  if (request.stop) {
    generationConfig.stopSequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  }

  // Handle extended thinking (Claude-specific)
  if (request.thinking?.type === 'enabled') {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: request.thinking.budget_tokens,
    };
  }

  if (Object.keys(generationConfig).length > 0) {
    result.generationConfig = generationConfig;
  }

  return result;
}

/**
 * Extract model from OpenAI request
 */
export function extractModel(request: OpenAIChatRequest): string {
  return request.model;
}

/**
 * Check if request wants streaming
 */
export function isStreamingRequest(request: OpenAIChatRequest): boolean {
  return request.stream === true;
}

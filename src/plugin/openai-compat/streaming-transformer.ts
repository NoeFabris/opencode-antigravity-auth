/**
 * Streaming Transformer: Antigravity SSE → OpenAI Streaming Format
 * 
 * Converts Antigravity's SSE events to OpenAI Chat Completions streaming format
 */

import type {
  OpenAIStreamChunk,
  OpenAIStreamChoice,
  OpenAIStreamDelta,
  OpenAIStreamToolCall,
} from './types.js';

/**
 * State for tracking streaming response
 */
interface StreamingState {
  id: string;
  model: string;
  created: number;
  currentToolCalls: Map<number, Partial<OpenAIStreamToolCall>>;
  hasStarted: boolean;
  thinkingContent: string;
  isThinking: boolean;
}

/**
 * Create initial streaming state
 */
export function createStreamingState(model: string): StreamingState {
  return {
    id: `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 9)}`,
    model,
    created: Math.floor(Date.now() / 1000),
    currentToolCalls: new Map(),
    hasStarted: false,
    thinkingContent: '',
    isThinking: false,
  };
}

/**
 * Create an OpenAI streaming chunk
 */
function createChunk(
  state: StreamingState,
  delta: OpenAIStreamDelta,
  finishReason: OpenAIStreamChoice['finish_reason'] = null
): OpenAIStreamChunk {
  return {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
  };
}

/**
 * Convert Antigravity finish reason to OpenAI format
 */
function convertFinishReason(
  finishReason: string | undefined
): OpenAIStreamChoice['finish_reason'] {
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
      return null;
  }
}

/**
 * Parse a line from the Antigravity SSE stream
 */
function parseSSELine(line: string): { event?: string; data?: string } | null {
  if (!line || line.startsWith(':')) return null;
  
  if (line.startsWith('event:')) {
    return { event: line.slice(6).trim() };
  }
  if (line.startsWith('data:')) {
    return { data: line.slice(5).trim() };
  }
  
  return null;
}

/**
 * Transform an Antigravity SSE event to OpenAI streaming chunks
 * Returns an array of chunks (may be empty or multiple)
 */
export function transformSSEEvent(
  eventType: string,
  data: unknown,
  state: StreamingState
): OpenAIStreamChunk[] {
  const chunks: OpenAIStreamChunk[] = [];
  
  // Handle different event types from Antigravity/Google API
  switch (eventType) {
    case 'message_start':
    case 'content_block_start': {
      if (!state.hasStarted) {
        // Send initial chunk with role
        chunks.push(createChunk(state, { role: 'assistant' }));
        state.hasStarted = true;
      }
      
      // Check if this is a thinking block
      const blockData = data as { content_block?: { type?: string } };
      if (blockData?.content_block?.type === 'thinking') {
        state.isThinking = true;
      }
      break;
    }
    
    case 'content_block_delta': {
      const deltaData = data as { 
        delta?: { 
          type?: string;
          text?: string;
          thinking?: string;
          partial_json?: string;
        };
        index?: number;
      };
      
      if (deltaData?.delta) {
        const delta = deltaData.delta;
        
        // Handle thinking delta
        if (delta.type === 'thinking_delta' || delta.thinking) {
          const thinkingText = delta.thinking || delta.text || '';
          if (thinkingText) {
            state.thinkingContent += thinkingText;
            chunks.push(createChunk(state, { thinking: thinkingText }));
          }
        }
        // Handle text delta
        else if (delta.type === 'text_delta' || delta.text) {
          const text = delta.text || '';
          if (text) {
            chunks.push(createChunk(state, { content: text }));
          }
        }
        // Handle tool use delta (function arguments)
        else if (delta.type === 'input_json_delta' && delta.partial_json) {
          const index = deltaData.index || 0;
          const toolCall = state.currentToolCalls.get(index);
          if (toolCall && toolCall.function?.name) {
            chunks.push(createChunk(state, {
              tool_calls: [{
                index,
                id: toolCall.id || '',
                type: 'function',
                function: { name: toolCall.function.name, arguments: delta.partial_json },
              }],
            }));
          }
        }
      }
      break;
    }
    
    case 'content_block_stop': {
      state.isThinking = false;
      break;
    }
    
    case 'message_delta': {
      const msgData = data as { 
        delta?: { stop_reason?: string };
        usage?: { output_tokens?: number };
      };
      
      if (msgData?.delta?.stop_reason) {
        const finishReason = convertFinishReason(msgData.delta.stop_reason);
        chunks.push(createChunk(state, {}, finishReason));
      }
      break;
    }
    
    case 'message_stop': {
      // Final chunk - ensure we have a finish_reason
      const lastChunk = chunks[chunks.length - 1];
      if (chunks.length === 0 || (lastChunk && lastChunk.choices[0]?.finish_reason === null)) {
        chunks.push(createChunk(state, {}, 'stop'));
      }
      break;
    }
    
    // Google/Antigravity direct streaming format
    default: {
      // Try to parse as direct candidate update
      const candidateData = data as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
              thought?: boolean;
              functionCall?: { name: string; args: Record<string, unknown>; id?: string };
            }>;
          };
          finishReason?: string;
        }>;
      };
      
      if (candidateData?.candidates?.[0]) {
        const candidate = candidateData.candidates[0];
        
        if (!state.hasStarted) {
          chunks.push(createChunk(state, { role: 'assistant' }));
          state.hasStarted = true;
        }
        
        if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.thought && part.text) {
              state.thinkingContent += part.text;
              chunks.push(createChunk(state, { thinking: part.text }));
            } else if (part.text) {
              chunks.push(createChunk(state, { content: part.text }));
            } else if (part.functionCall) {
              const toolCallIndex = state.currentToolCalls.size;
              const toolCall: OpenAIStreamToolCall = {
                index: toolCallIndex,
                id: part.functionCall.id || `call_${Math.random().toString(36).substring(2, 11)}`,
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args || {}),
                },
              };
              state.currentToolCalls.set(toolCallIndex, toolCall);
              chunks.push(createChunk(state, {
                tool_calls: [toolCall],
              }));
            }
          }
        }
        
        if (candidate.finishReason) {
          const finishReason = convertFinishReason(candidate.finishReason);
          chunks.push(createChunk(state, {}, finishReason));
        }
      }
    }
  }
  
  return chunks;
}

/**
 * Format chunks as SSE data lines for OpenAI format
 */
export function formatChunksAsSSE(chunks: OpenAIStreamChunk[]): string {
  let result = '';
  for (const chunk of chunks) {
    result += `data: ${JSON.stringify(chunk)}\n\n`;
  }
  return result;
}

/**
 * Create the final [DONE] SSE message
 */
export function createDoneMessage(): string {
  return 'data: [DONE]\n\n';
}

/**
 * Create a TransformStream that converts Antigravity SSE to OpenAI format
 */
export function createOpenAIStreamTransformer(model: string): TransformStream<Uint8Array, Uint8Array> {
  const state = createStreamingState(model);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let currentEvent = '';
  
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        const parsed = parseSSELine(trimmed);
        if (!parsed) continue;
        
        if (parsed.event) {
          currentEvent = parsed.event;
        } else if (parsed.data) {
          if (parsed.data === '[DONE]') {
            controller.enqueue(encoder.encode(createDoneMessage()));
            return;
          }
          
          try {
            const data = JSON.parse(parsed.data);
            const eventType = currentEvent || 'candidate';
            const chunks = transformSSEEvent(eventType, data, state);
            
            if (chunks.length > 0) {
              controller.enqueue(encoder.encode(formatChunksAsSSE(chunks)));
            }
            
            currentEvent = '';
          } catch {
            // Skip invalid JSON
          }
        }
      }
    },
    
    flush(controller) {
      // Process any remaining buffer
      if (buffer.trim()) {
        const parsed = parseSSELine(buffer.trim());
        if (parsed?.data && parsed.data !== '[DONE]') {
          try {
            const data = JSON.parse(parsed.data);
            const chunks = transformSSEEvent(currentEvent || 'candidate', data, state);
            if (chunks.length > 0) {
              controller.enqueue(encoder.encode(formatChunksAsSSE(chunks)));
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
      
      // Send [DONE] if not already sent
      controller.enqueue(encoder.encode(createDoneMessage()));
    },
  });
}

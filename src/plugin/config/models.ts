import type { ProviderModel } from "../types";

export type ModelThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface ModelThinkingConfig {
  thinkingBudget: number;
}

export interface ModelVariant {
  thinkingLevel?: ModelThinkingLevel;
  thinkingConfig?: ModelThinkingConfig;
}

export interface ModelLimit {
  context: number;
  output: number;
}

export type ModelModality = "text" | "image" | "pdf";

export interface ModelModalities {
  input: ModelModality[];
  output: ModelModality[];
}

export interface OpencodeModelDefinition extends ProviderModel {
  name: string;
  limit: ModelLimit;
  modalities: ModelModalities;
  variants?: Record<string, ModelVariant>;
}

export type OpencodeModelDefinitions = Record<string, OpencodeModelDefinition>;

const DEFAULT_MODALITIES: ModelModalities = {
  input: ["text", "image", "pdf"],
  output: ["text"],
};

export const OPENCODE_MODEL_DEFINITIONS: OpencodeModelDefinitions = {
  "antigravity-gemini-3.1-pro-low": {
    name: "Gemini 3.1 Pro Low (Antigravity)",
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-gemini-3.1-pro-high": {
    name: "Gemini 3.1 Pro High (Antigravity)",
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6 (Antigravity)",
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-claude-opus-4-6-thinking": {
    name: "Claude Opus 4.6 Thinking (Antigravity)",
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-gpt-oss-120b-medium": {
    name: "GPT-OSS 120B Medium (Antigravity)",
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-gemini-3.5-flash-low": {
    name: "Gemini 3.5 Flash Low (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
  },
};

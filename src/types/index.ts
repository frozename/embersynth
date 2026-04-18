// ── Capabilities ──

export const CAPABILITIES = [
  'reasoning',
  'vision',
  'embedding',
  'retrieval',
  'memory',
  'utility',
  'rerank',
  'speech-to-text',
  'text-to-speech',
  'tool-execution',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

// ── Node Definition ──

export type TransportType = 'http' | 'https';

export interface NodeAuth {
  type: 'bearer' | 'header' | 'none';
  token?: string;
  headerName?: string;
  headerValue?: string;
}

export interface NodeHealthConfig {
  endpoint?: string; // defaults to /health
  intervalMs?: number; // health check interval
  timeoutMs?: number; // health check timeout
  unhealthyAfter?: number; // consecutive failures before marking unhealthy
}

export interface NodeTimeoutConfig {
  requestMs?: number; // per-request timeout
  connectMs?: number; // connection timeout
}

export interface OptimizationMetadata {
  quantization?: string; // e.g. "Q4_K_M", "GPTQ-4bit"
  kvCacheQuantization?: string; // e.g. "Q8_0"
  contextWindow?: number; // max context length
  maxBatchSize?: number;
  offloadLayers?: number;
  customHints?: Record<string, unknown>;
}

export interface NodeDefinition {
  id: string;
  label: string;
  endpoint: string;
  transport: TransportType;
  enabled: boolean;
  capabilities: Capability[];
  tags: string[];
  auth: NodeAuth;
  health: NodeHealthConfig;
  timeout: NodeTimeoutConfig;
  priority: number; // lower = higher priority
  modelId?: string; // model ID at the provider
  providerType: string; // adapter key, e.g. "openai-compatible"
  optimization?: OptimizationMetadata;
}

// ── Health ──

export type HealthState = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface HealthStatus {
  nodeId: string;
  state: HealthState;
  lastCheck?: number;
  lastSuccess?: number;
  consecutiveFailures: number;
  latencyMs?: number;
  error?: string;
}

// ── Routing Profiles ──

export interface RoutingProfile {
  id: string;
  label: string;
  description?: string;
  preferredCapabilities?: Capability[];
  requiredTags?: string[];
  excludedTags?: string[];
  maxLatencyMs?: number;
  preferLowerPriority?: boolean; // prefer nodes with lower priority number
  allowDegradedNodes?: boolean;
  maxStages?: number;
  synthesisRequired?: boolean;
}

// ── Routing Policy ──

export interface RoutingPolicy {
  fallbackEnabled: boolean;
  maxRetries: number;
  retryDelayMs: number;
  requireHealthy: boolean;
  evidenceCompression: boolean;
  evidenceMaxLength?: number; // max chars per evidence item before compression
}

// ── Request Classification ──

export interface RequestClassification {
  requiredCapabilities: Capability[];
  hasVisionContent: boolean;
  hasEmbeddingRequest: boolean;
  hasRetrievalNeed: boolean;
  hasMemoryNeed: boolean;
  hasToolUse: boolean;
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
  suggestedStages: Capability[][];
}

// ── Execution Plan ──

export interface PlanStage {
  stageIndex: number;
  capability: Capability;
  capabilities?: Capability[];
  nodeId: string;
  nodeLabel: string;
  inputType: 'original' | 'evidence';
  description: string;
}

export interface ExecutionPlan {
  id: string;
  profileId: string;
  stages: PlanStage[];
  requiresSynthesis: boolean;
  classification: RequestClassification;
  createdAt: number;
}

// ── Evidence ──

export interface EvidenceItem {
  stageIndex: number;
  nodeId: string;
  capability: Capability;
  content: string;
  metadata?: Record<string, unknown>;
  durationMs: number;
  timestamp: number;
}

export interface EvidenceBundle {
  planId: string;
  items: EvidenceItem[];
  totalDurationMs: number;
}

// ── Provider Adapter ──

export interface AdapterRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  evidence?: EvidenceBundle;
  systemPromptOverride?: string;
  tools?: ChatCompletionRequest['tools'];
  toolChoice?: ChatCompletionRequest['tool_choice'];
}

export interface AdapterResponse {
  content: string;
  finishReason: string;
  toolCalls?: import('./tools.js').ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  raw?: unknown;
}

export interface EmbeddingAdapterRequest {
  input: string[];
  model?: string;
}

export interface EmbeddingAdapterResponse {
  embeddings: number[][];
  usage?: {
    promptTokens: number;
    totalTokens: number;
  };
}

export interface ProviderAdapter {
  readonly type: string;
  sendRequest(node: NodeDefinition, request: AdapterRequest): Promise<AdapterResponse>;
  sendStreamingRequest?(node: NodeDefinition, request: AdapterRequest): AsyncGenerator<string>;
  sendEmbeddingRequest?(node: NodeDefinition, request: EmbeddingAdapterRequest): Promise<EmbeddingAdapterResponse>;
  checkHealth(node: NodeDefinition): Promise<HealthStatus>;
}

// ── Orchestration Result ──

export interface OrchestrationResult {
  response: AdapterResponse;
  plan: ExecutionPlan;
  evidence?: EvidenceBundle;
  totalDurationMs: number;
}

export interface StreamingOrchestrationResult {
  stream: ReadableStream<Uint8Array>;
  plan: ExecutionPlan;
  evidence?: EvidenceBundle;
}

// ── OpenAI-compatible API types ──
//
// The chat-message family below is now sourced from @nova/contracts.
// Local names remain as aliases so existing consumers keep compiling
// without a big-bang import rewrite; the Nova types are wire-compatible
// supersets (Nova's ChatMessage adds a 'developer' role and an optional
// `name` field, ContentPart adds an audio block variant — all
// backwards-safe for existing usage sites).

import type {
  ChatMessage as NovaChatMessage,
  ContentBlock as NovaContentBlock,
  UnifiedAiRequest as NovaUnifiedAiRequest,
} from '@nova/contracts';

export type ChatMessage = NovaChatMessage;
export type ContentPart = NovaContentBlock;
export type TextContent = Extract<NovaContentBlock, { type: 'text' }>;
export type ImageContent = Extract<NovaContentBlock, { type: 'image_url' }>;

/**
 * Chat-completion request — alias onto @nova/contracts. Nova's shape
 * is a proper superset of the OpenAI chat-completion dialect
 * embersynth was modelling locally; additional fields (`stop`,
 * `response_format`, `user`, `providerOptions`, `capabilities`) are
 * all optional and flow through without affecting existing routing.
 * Nova's `tool_choice` also accepts `'required'`, which OpenAI added
 * after embersynth's local type was written.
 */
export type ChatCompletionRequest = NovaUnifiedAiRequest;

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: import('./tools.js').ToolCall[];
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: import('./tools.js').ToolCallDelta[];
    };
    finish_reason: string | null;
  }[];
}

// ── Embeddings API types ──
//
// Sourced from @nova/contracts. Nova's shape is a proper superset:
// accepts additional input types (numeric arrays for pre-tokenized
// input), surfaces `user` / `dimensions` / `providerOptions`, and
// allows `embedding` to be a base64-encoded string when
// `encoding_format: 'base64'` is set. All fields that embersynth
// previously used keep the same names and semantics.

import type {
  UnifiedEmbeddingRequest as NovaUnifiedEmbeddingRequest,
  UnifiedEmbeddingResponse as NovaUnifiedEmbeddingResponse,
} from '@nova/contracts';

export type EmbeddingRequest = NovaUnifiedEmbeddingRequest;
export type EmbeddingResponse = NovaUnifiedEmbeddingResponse;

// ── Responses API types ──

export interface ResponsesRequest {
  model: string;
  input: string | ResponsesInputMessage[];
  instructions?: string;
  temperature?: number;
  max_output_tokens?: number;
  tools?: ChatCompletionRequest['tools'];
  tool_choice?: ChatCompletionRequest['tool_choice'];
  stream?: boolean;
}

export interface ResponsesInputMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentPart[];
}

export interface ResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  output: ResponsesOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export interface ResponsesOutputItem {
  type: 'message';
  id: string;
  role: 'assistant';
  content: { type: 'output_text'; text: string }[];
}

// ── Model List ──

export interface ModelListResponse {
  object: 'list';
  data: {
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
    capabilities?: Capability[];
    description?: string;
  }[];
}

// ── Config ──

export interface EmberSynthConfig {
  server: {
    host: string;
    port: number;
    logLevel?: string;
    watch?: boolean;
  };
  nodes: NodeDefinition[];
  profiles: RoutingProfile[];
  policy: RoutingPolicy;
  syntheticModels: Record<string, string>; // model ID -> profile ID
}

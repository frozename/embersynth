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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: import('./tools.js').ToolCall[];
  tool_call_id?: string;
}

export type ContentPart = TextContent | ImageContent;

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  tools?: { type: 'function'; function: import('./tools.js').ToolDefinition }[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

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
    };
    finish_reason: string | null;
  }[];
}

// ── Embeddings API types ──

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
}

export interface EmbeddingResponse {
  object: 'list';
  data: {
    object: 'embedding';
    embedding: number[];
    index: number;
  }[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// ── Responses API types ──

export interface ResponsesRequest {
  model: string;
  input: string | ResponsesInputMessage[];
  instructions?: string;
  temperature?: number;
  max_output_tokens?: number;
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

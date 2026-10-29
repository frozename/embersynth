import type {
  ExecutionPlan,
  AdapterRequest,
  AdapterResponse,
  EvidenceBundle,
  EvidenceItem,
  OrchestrationResult,
  StreamingOrchestrationResult,
  ChatMessage,
  ChatCompletionChunk,
  ChatCompletionRequest,
  RoutingPolicy,
  RoutingProfile,
  Capability,
} from '../types/index.js';
import type { NodeRegistry } from '../registry/registry.js';
import { getAdapter } from '../adapters/index.js';
import { TOOL_CALLS_MARKER, FINISH_REASON_MARKER, mergeToolCallDeltas, type ToolCallMap } from '../adapters/stream-markers.js';
import { compressEvidence } from '../evidence/compressor.js';
import { withRequestId } from '../logger/index.js';

/**
 * Thrown by executePlanStreaming when a non-final stage fails, so routeStreaming
 * can tell it apart from a failure of the final-stage stream (#12).
 */
export class StageExecutionError extends Error {
  readonly stageIndex: number;

  constructor(stageIndex: number, message: string) {
    super(message);
    this.name = 'StageExecutionError';
    this.stageIndex = stageIndex;
  }
}

/** Execute a plan stage by stage, building up evidence */
export async function executePlan(
  plan: ExecutionPlan,
  originalMessages: ChatMessage[],
  registry: NodeRegistry,
  policy: RoutingPolicy,
  profile: RoutingProfile,
  options?: {
    temperature?: number;
    maxTokens?: number;
    tools?: ChatCompletionRequest['tools'];
    toolChoice?: ChatCompletionRequest['tool_choice'];
  },
  signal?: AbortSignal,
): Promise<OrchestrationResult> {
  const rlog = withRequestId(plan.id);
  const evidence: EvidenceBundle = {
    planId: plan.id,
    items: [],
    totalDurationMs: 0,
  };

  const planStart = Date.now();
  let lastResponse: AdapterResponse | null = null;
  const failedNodeIds = new Set<string>();

  for (let stageIdx = 0; stageIdx < plan.stages.length; stageIdx++) {
    const stage = plan.stages[stageIdx];
    const isLastStage = stageIdx === plan.stages.length - 1;

    const result = await executeStageWithFallback(
      stage,
      originalMessages,
      evidence,
      isLastStage,
      registry,
      policy,
      profile,
      failedNodeIds,
      options,
      rlog,
      signal,
    );

    if (!result) {
      throw new Error(
        `Stage ${stageIdx} (${stage.capability}) failed: no healthy nodes available after fallback`,
      );
    }

    const { response, nodeId, durationMs } = result;

    // Collect evidence from non-final stages
    if (!isLastStage) {
      const evidenceItem: EvidenceItem = {
        stageIndex: stageIdx,
        nodeId,
        capability: stage.capability,
        content: response.content,
        durationMs,
        timestamp: Date.now(),
      };
      evidence.items.push(evidenceItem);
    }

    lastResponse = response;
  }

  evidence.totalDurationMs = Date.now() - planStart;

  return {
    response: lastResponse!,
    plan,
    evidence: evidence.items.length > 0 ? evidence : undefined,
    totalDurationMs: evidence.totalDurationMs,
  };
}

/** Execute a plan with the final stage streamed as SSE */
export async function executePlanStreaming(
  plan: ExecutionPlan,
  originalMessages: ChatMessage[],
  registry: NodeRegistry,
  policy: RoutingPolicy,
  profile: RoutingProfile,
  model: string,
  options?: {
    temperature?: number;
    maxTokens?: number;
    tools?: ChatCompletionRequest['tools'];
    toolChoice?: ChatCompletionRequest['tool_choice'];
  },
  signal?: AbortSignal,
): Promise<StreamingOrchestrationResult> {
  const rlog = withRequestId(plan.id);
  const evidence: EvidenceBundle = {
    planId: plan.id,
    items: [],
    totalDurationMs: 0,
  };
  const failedNodeIds = new Set<string>();

  // Execute all non-final stages synchronously to gather evidence
  for (let stageIdx = 0; stageIdx < plan.stages.length - 1; stageIdx++) {
    const stage = plan.stages[stageIdx];

    rlog.info('executing intermediate stage', {
      stage: stageIdx,
      capability: stage.capability,
      nodeId: stage.nodeId,
    });

    const result = await executeStageWithFallback(
      stage,
      originalMessages,
      evidence,
      false,
      registry,
      policy,
      profile,
      failedNodeIds,
      options,
      rlog,
      signal,
    );

    if (!result) {
      throw new StageExecutionError(
        stageIdx,
        `Stage ${stageIdx} (${stage.capability}) failed: no healthy nodes available after fallback`,
      );
    }

    evidence.items.push({
      stageIndex: stageIdx,
      nodeId: result.nodeId,
      capability: stage.capability,
      content: result.response.content,
      durationMs: result.durationMs,
      timestamp: Date.now(),
    });
  }

  // Stream the final stage — with fallback
  const finalStage = plan.stages[plan.stages.length - 1];
  const failedStreamNodes = new Set<string>();
  let streamGen: AsyncGenerator<string> | null = null;
  let streamFirstChunk: string | null = null;
  let streamNodeId = finalStage.nodeId;
  let streamFinishReason = 'stop';
  const toolCallMap: ToolCallMap = new Map();

  // Try primary node, then fallbacks
  const allCandidates = registry.findByCapabilities(finalStage.capabilities ?? [finalStage.capability]);
  const tagFiltered = registry.filterByTags(
    allCandidates.filter((n) => n.id !== finalStage.nodeId),
    profile.requiredTags,
    profile.excludedTags,
  );
  const healthFiltered = policy.requireHealthy
    ? registry.filterByHealth(tagFiltered, profile.allowDegradedNodes)
    : tagFiltered;
  const sorted = registry.sortByPriority(healthFiltered);

  const profileFiltered = registry.applyProfileConstraints(sorted, profile);
  // #43: with fallback disabled only the primary is tried, as in executeStageWithFallback.
  const candidates = policy.fallbackEnabled
    ? [finalStage.nodeId, ...profileFiltered.map((n) => n.id)]
    : [finalStage.nodeId];

  for (const candidateId of candidates) {
    if (failedStreamNodes.has(candidateId)) continue;
    const candidateNode = registry.getById(candidateId);
    if (!candidateNode) continue;
    const candidateAdapter = getAdapter(candidateNode.providerType);
    if (!candidateAdapter?.sendStreamingRequest) continue;

    const compressedEvidence = evidence.items.length > 0
      ? compressEvidence(evidence, policy)
      : undefined;

    const request: AdapterRequest = {
      messages: originalMessages,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      evidence: compressedEvidence,
      stream: true,
      tools: options?.tools,
      toolChoice: options?.toolChoice,
    };

    try {
      const candidateGen = candidateAdapter.sendStreamingRequest(candidateNode, request, signal);
      // Force the first chunk to validate the connection actually works
      const firstResult = await candidateGen.next();
      // Connection validated — store generator and first chunk
      streamGen = candidateGen;
      streamFirstChunk = firstResult.done ? null : firstResult.value;
      streamNodeId = candidateId;
      break;
    } catch (err) {
      // #8: a caller cancel is not a node failure; stop without touching health.
      if (signal?.aborted) throw err;
      failedStreamNodes.add(candidateId);
      registry.updateHealth(candidateId, 'unhealthy');
      rlog.warn('streaming candidate failed, trying next', { nodeId: candidateId });
    }
  }

  if (!streamGen) {
    throw new Error(`No streaming-capable node available for capability "${finalStage.capability}"`);
  }
  const upstream: AsyncGenerator<string> = streamGen;

  rlog.info('streaming final stage', {
    capability: finalStage.capability,
    nodeId: streamNodeId,
  });

  const chunkId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const finalNodeId = streamNodeId;

  // Produces the SSE bytes for the final stage. Driven by the stream's pull()
  // below, so an upstream truncation errors the stream only after every chunk
  // produced before it has been handed to the reader (#3).
  async function* produceSse(): AsyncGenerator<Uint8Array> {
    const encoder = new TextEncoder();

    // Send initial chunk with role
    const initialChunk: ChatCompletionChunk = {
      id: chunkId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    };
    yield encoder.encode(`data: ${JSON.stringify(initialChunk)}\n\n`);

    try {
      // Emit the first chunk that was consumed during validation
      if (streamFirstChunk) {
        if (streamFirstChunk.startsWith(TOOL_CALLS_MARKER)) {
          mergeToolCallDeltas(toolCallMap, streamFirstChunk);
        } else if (streamFirstChunk.startsWith(FINISH_REASON_MARKER)) {
          streamFinishReason = streamFirstChunk.slice(FINISH_REASON_MARKER.length);
        } else {
          const chunk: ChatCompletionChunk = {
            id: chunkId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: streamFirstChunk }, finish_reason: null }],
          };
          yield encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      }

      for await (const text of upstream) {
        if (text.startsWith(TOOL_CALLS_MARKER)) {
          mergeToolCallDeltas(toolCallMap, text);
          continue;
        }
        if (text.startsWith(FINISH_REASON_MARKER)) {
          streamFinishReason = text.slice(FINISH_REASON_MARKER.length);
          continue;
        }
        const chunk: ChatCompletionChunk = {
          id: chunkId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        };
        yield encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      // Send final chunk
      const doneChunk: ChatCompletionChunk = {
        id: chunkId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{
          index: 0,
          delta: toolCallMap.size > 0
            ? { tool_calls: Array.from(toolCallMap.entries()).map(([idx, tc]) => ({ index: idx, ...tc })) }
            : {},
          finish_reason: streamFinishReason,
        }],
      };
      yield encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`);
      yield encoder.encode('data: [DONE]\n\n');

      registry.updateHealth(finalNodeId, 'healthy');
    } catch (err) {
      registry.updateHealth(
        finalNodeId,
        'unhealthy',
        undefined,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  const sse = produceSse();
  // pull() runs only when the queue is empty, so controller.error on a
  // truncated upstream never discards chunks that were already queued (#3).
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await sse.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await sse.return(undefined);
    },
  });

  return {
    stream,
    plan,
    evidence: evidence.items.length > 0 ? evidence : undefined,
  };
}

// ── Internal helpers ──

interface StageResult {
  response: AdapterResponse;
  nodeId: string;
  durationMs: number;
}

type Log = ReturnType<typeof withRequestId>;

/** Execute a stage with retry logic and dynamic fallback to alternate nodes */
async function executeStageWithFallback(
  stage: import('../types/index.js').PlanStage,
  originalMessages: ChatMessage[],
  evidence: EvidenceBundle,
  isLastStage: boolean,
  registry: NodeRegistry,
  policy: RoutingPolicy,
  profile: RoutingProfile,
  failedNodeIds: Set<string>,
  options?: {
    temperature?: number;
    maxTokens?: number;
    tools?: ChatCompletionRequest['tools'];
    toolChoice?: ChatCompletionRequest['tool_choice'];
  },
  rlog?: Log,
  signal?: AbortSignal,
): Promise<StageResult | null> {
  const capability = stage.capability;
  const primaryNodeId = stage.nodeId;

  // Try the primary node first
  const primaryResult = await attemptNode(
    primaryNodeId,
    capability,
    originalMessages,
    evidence,
    isLastStage,
    registry,
    policy,
    options,
    rlog,
    signal,
  );

  if (primaryResult) return primaryResult;

  // Primary failed — try fallback if policy allows
  if (!policy.fallbackEnabled) return null;

  failedNodeIds.add(primaryNodeId);
  rlog?.warn('primary node failed, attempting fallback', {
    capability,
    failedNode: primaryNodeId,
  });

  // Find alternate node via planner
  const alternates = registry.findByCapabilities(stage.capabilities ?? [capability]);
  const filtered = registry.filterByTags(
    alternates.filter((n) => !failedNodeIds.has(n.id)),
    profile.requiredTags,
    profile.excludedTags,
  );
  const healthy = policy.requireHealthy
    ? registry.filterByHealth(filtered, profile.allowDegradedNodes)
    : filtered;
  const sorted = registry.sortByPriority(healthy);

  const finalCandidates = registry.applyProfileConstraints(sorted, profile);

  for (const fallbackNode of finalCandidates) {
    rlog?.info('trying fallback node', { nodeId: fallbackNode.id, capability });

    const result = await attemptNode(
      fallbackNode.id,
      capability,
      originalMessages,
      evidence,
      isLastStage,
      registry,
      policy,
      options,
      rlog,
      signal,
    );

    if (result) return result;

    failedNodeIds.add(fallbackNode.id);
  }

  return null;
}

/** Attempt to execute on a specific node with retries */
async function attemptNode(
  nodeId: string,
  capability: Capability,
  originalMessages: ChatMessage[],
  evidence: EvidenceBundle,
  isLastStage: boolean,
  registry: NodeRegistry,
  policy: RoutingPolicy,
  options?: {
    temperature?: number;
    maxTokens?: number;
    tools?: ChatCompletionRequest['tools'];
    toolChoice?: ChatCompletionRequest['tool_choice'];
  },
  rlog?: Log,
  signal?: AbortSignal,
): Promise<StageResult | null> {
  const node = registry.getById(nodeId);
  if (!node) return null;

  const adapter = getAdapter(node.providerType);
  if (!adapter) return null;

  const hasEvidence = evidence.items.length > 0;
  const compressedEvidence = hasEvidence ? compressEvidence(evidence, policy) : undefined;

  const request: AdapterRequest = {
    messages: originalMessages,
    temperature: options?.temperature,
    maxTokens: options?.maxTokens,
    evidence: compressedEvidence,
    ...(isLastStage ? { tools: options?.tools, toolChoice: options?.toolChoice } : {}),
  };

  if (!isLastStage) {
    request.systemPromptOverride = buildIntermediatePrompt(capability);
  }

  const maxAttempts = policy.maxRetries + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const stageStart = Date.now();

    try {
      const response = await adapter.sendRequest(node, request, signal);
      const durationMs = Date.now() - stageStart;
      registry.updateHealth(node.id, 'healthy', durationMs);

      rlog?.info('stage completed', {
        nodeId,
        capability,
        durationMs,
        attempt,
      });

      return { response, nodeId, durationMs };
    } catch (err) {
      // #8: the caller's own signal fired (client disconnect or upstream
      // cancel). That is not a node failure: no health update, no retry,
      // no fallback. A per-node timeout aborts the adapter's merged signal,
      // not this one, so it still counts as a failure below.
      if (signal?.aborted) throw err;
      const errMsg = err instanceof Error ? err.message : String(err);
      registry.updateHealth(node.id, 'unhealthy', undefined, errMsg);

      rlog?.warn('stage attempt failed', {
        nodeId,
        capability,
        attempt,
        error: errMsg,
      });

      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, policy.retryDelayMs));
      }
    }
  }

  return null;
}

/** Generate a system prompt for intermediate stages */
function buildIntermediatePrompt(capability: string): string {
  switch (capability) {
    case 'vision':
      return [
        'You are a vision analysis stage in a multi-step pipeline.',
        'Analyze the provided image(s) thoroughly and produce a detailed structured description.',
        'Include: visual elements, text content, layout, colors, relationships between elements.',
        'Your output will be used as evidence for a subsequent reasoning stage.',
        'Be factual and comprehensive. Do not speculate beyond what is visible.',
      ].join(' ');

    case 'retrieval':
      return [
        'You are a retrieval stage in a multi-step pipeline.',
        'Extract and organize the most relevant information from your knowledge or provided context.',
        'Structure your output as clear, factual evidence that a reasoning model can synthesize.',
        'Include source references where possible.',
      ].join(' ');

    case 'memory':
      return [
        'You are a memory/recall stage in a multi-step pipeline.',
        'Recall relevant context from prior conversations or stored information.',
        'Present recalled information as structured evidence for the next stage.',
        'Clearly indicate confidence levels and temporal context for each recalled item.',
      ].join(' ');

    case 'utility':
      return [
        'You are a utility/preprocessing stage in a multi-step pipeline.',
        'Process the input and produce clean, structured output.',
        'Your output will be used as input for subsequent stages.',
      ].join(' ');

    default:
      return `You are a ${capability} stage in a multi-step pipeline. Produce structured output for the next stage.`;
  }
}

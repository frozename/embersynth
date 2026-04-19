import type {
  ChatCompletionRequest,
  EmberSynthConfig,
  NodeDefinition,
  OrchestrationResult,
  StreamingOrchestrationResult,
  EmbeddingRequest,
  EmbeddingAdapterResponse,
  ExecutionPlan,
  RoutingProfile,
} from '../types/index.js';
import type { NodeRegistry } from '../registry/registry.js';
import type { TraceContext } from '../tracing/context.js';
import { classifyRequest } from './classifier.js';
import { buildPlan } from './planner.js';
import { executePlan, executePlanStreaming } from './executor.js';
import { resolveProfileFromModel } from '../config/loader.js';
import { getAdapter } from '../adapters/index.js';
import { log } from '../logger/index.js';
import { appendEvidence } from '../evidence/index.js';

export interface RouterError {
  status: number;
  message: string;
  detail?: string;
}

export type RouterResult =
  | { ok: true; result: OrchestrationResult }
  | { ok: false; error: RouterError };

export type StreamingRouterResult =
  | { ok: true; result: StreamingOrchestrationResult }
  | { ok: false; error: RouterError };

export type EmbeddingRouterResult =
  | { ok: true; result: EmbeddingAdapterResponse; model: string; nodeId: string }
  | { ok: false; error: RouterError };

/**
 * Simulated-route candidate — the shape the MCP `embersynth.route.simulate`
 * tool returns. Score is derived from node priority (lower priority
 * number → higher score, inverted to [0,1]); reasons list the matched
 * required tags, capabilities, and the stage that selected the node.
 */
export interface SimulatedCandidate {
  nodeId: string;
  score: number;
  reasons: string[];
}

export interface SimulatedPlan {
  profileId: string;
  candidates: SimulatedCandidate[];
  winner: { nodeId: string } | null;
  plan?: ExecutionPlan;
}

export type SimulatedPlanResult =
  | { ok: true; result: SimulatedPlan }
  | { ok: false; error: RouterError };

function candidateReasons(
  node: NodeDefinition,
  profile: RoutingProfile,
  finalCapabilities: readonly string[],
): string[] {
  const reasons: string[] = [];
  const nodeCapSet: string[] = node.capabilities as unknown as string[];
  const matchedCaps = finalCapabilities.filter((c) => nodeCapSet.includes(c));
  if (matchedCaps.length > 0) {
    reasons.push(`capabilities:${matchedCaps.join(',')}`);
  }
  if (profile.requiredTags?.length) {
    const matched = profile.requiredTags.filter((t) => node.tags.includes(t));
    if (matched.length > 0) reasons.push(`tags:${matched.join(',')}`);
  }
  reasons.push(`priority:${node.priority}`);
  return reasons;
}

/**
 * Plan-only variant of `route()` — computes the classification + plan
 * for inspection/simulation without executing anything. Pure: no
 * network calls, no registry mutation, no audit side-effects. Used by
 * the MCP `embersynth.route.simulate` tool.
 */
export function planRoute(
  request: ChatCompletionRequest,
  config: EmberSynthConfig,
  registry: NodeRegistry,
): SimulatedPlanResult {
  const profile = resolveProfileFromModel(request.model, config);
  if (!profile) {
    return {
      ok: false,
      error: {
        status: 400,
        message: `Unknown model "${request.model}". Available: ${Object.keys(config.syntheticModels).join(', ')}`,
      },
    };
  }

  const classification = classifyRequest(request.messages);
  const planResult = buildPlan(classification, profile, config.policy, registry);
  if (!planResult.ok) {
    const status = planResult.error.type === 'capability-gap' ? 422 : 503;
    return {
      ok: false,
      error: {
        status,
        message: planResult.error.message,
        detail: planResult.error.message,
      },
    };
  }

  const plan = planResult.plan;
  const finalStage = plan.stages[plan.stages.length - 1];
  const finalCaps = finalStage.capabilities ?? [finalStage.capability];

  // Candidate pool: nodes supporting the final stage's capability set,
  // filtered by profile tags. Score is priority-inverted into [0,1]:
  // lower priority number → higher score.
  let pool = registry.findByCapabilities(finalCaps);
  pool = registry.filterByTags(pool, profile.requiredTags, profile.excludedTags);
  const sorted = registry.sortByPriority(pool);
  const maxPriority = sorted.reduce((m, n) => Math.max(m, n.priority), 1) || 1;

  const candidates: SimulatedCandidate[] = sorted.map((n) => ({
    nodeId: n.id,
    score: Number((1 - n.priority / (maxPriority + 1)).toFixed(4)),
    reasons: candidateReasons(n, profile, finalCaps),
  }));

  return {
    ok: true,
    result: {
      profileId: profile.id,
      candidates,
      winner: { nodeId: finalStage.nodeId },
      plan,
    },
  };
}

/** Main router: classify -> plan -> execute */
export async function route(
  request: ChatCompletionRequest,
  config: EmberSynthConfig,
  registry: NodeRegistry,
  traceCtx?: TraceContext,
): Promise<RouterResult> {
  const profile = resolveProfileFromModel(request.model, config);
  if (!profile) {
    return {
      ok: false,
      error: {
        status: 400,
        message: `Unknown model "${request.model}". Available: ${Object.keys(config.syntheticModels).join(', ')}`,
      },
    };
  }

  const classification = classifyRequest(request.messages);

  log.debug('request classified', {
    profile: profile.id,
    capabilities: classification.requiredCapabilities,
    complexity: classification.estimatedComplexity,
    vision: classification.hasVisionContent,
    retrieval: classification.hasRetrievalNeed,
    memory: classification.hasMemoryNeed,
  });

  traceCtx?.record('classify', {
    capabilities: classification.requiredCapabilities,
    complexity: classification.estimatedComplexity,
    vision: classification.hasVisionContent,
    retrieval: classification.hasRetrievalNeed,
    memory: classification.hasMemoryNeed,
  });

  const planResult = buildPlan(classification, profile, config.policy, registry);
  if (!planResult.ok) {
    const status = planResult.error.type === 'capability-gap' ? 422 : 503;
    return {
      ok: false,
      error: {
        status,
        message: planResult.error.message,
        detail: planResult.error.message,
      },
    };
  }

  log.info('plan built', {
    planId: planResult.plan.id,
    stages: planResult.plan.stages.length,
    stageNodes: planResult.plan.stages.map((s) => `${s.capability}→${s.nodeId}`),
  });

  traceCtx?.record('plan', {
    planId: planResult.plan.id,
    stages: planResult.plan.stages.length,
    stageNodes: planResult.plan.stages.map((s) => `${s.capability}→${s.nodeId}`),
  });

  // One evidence record per routing decision — best-effort JSONL sink
  // read back via the MCP `embersynth.evidence.tail` tool. Never fails
  // the request.
  try {
    const finalStage = planResult.plan.stages[planResult.plan.stages.length - 1];
    const winnerNode = registry.getById(finalStage.nodeId);
    const finalCaps = finalStage.capabilities ?? [finalStage.capability];
    const finalCapNames: string[] = finalCaps as unknown as string[];
    const candidateNodes = registry
      .sortByPriority(registry.findByCapabilities(finalCaps))
      .map((n) => ({
        nodeId: n.id,
        score: 1 - n.priority / 100,
        reasons: [
          `capabilities:${finalCapNames.filter((c) => (n.capabilities as unknown as string[]).includes(c)).join(',')}`,
          `priority:${n.priority}`,
        ],
      }));
    appendEvidence({
      request,
      winner: winnerNode ? { nodeId: winnerNode.id } : null,
      candidates: candidateNodes,
    });
  } catch {
    // never fail routing on evidence logging
  }

  try {
    const execStart = Date.now();
    const result = await executePlan(
      planResult.plan,
      request.messages,
      registry,
      config.policy,
      profile,
      {
        temperature: request.temperature,
        maxTokens: request.max_tokens,
        tools: request.tools,
        toolChoice: request.tool_choice,
      },
    );

    traceCtx?.record('execute-complete', {
      durationMs: Date.now() - execStart,
      evidenceItems: result.evidence?.items.length ?? 0,
    });

    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('execution failed', {
      planId: planResult.plan.id,
      error: message,
    });
    traceCtx?.record('error', { message });
    return {
      ok: false,
      error: {
        status: 502,
        message: err instanceof Error ? err.message : 'Execution failed',
      },
    };
  }
}

/** Streaming variant: intermediate stages run synchronously, final stage streams */
export async function routeStreaming(
  request: ChatCompletionRequest,
  config: EmberSynthConfig,
  registry: NodeRegistry,
  traceCtx?: TraceContext,
): Promise<StreamingRouterResult> {
  const profile = resolveProfileFromModel(request.model, config);
  if (!profile) {
    return {
      ok: false,
      error: {
        status: 400,
        message: `Unknown model "${request.model}". Available: ${Object.keys(config.syntheticModels).join(', ')}`,
      },
    };
  }

  const classification = classifyRequest(request.messages);

  traceCtx?.record('classify', {
    capabilities: classification.requiredCapabilities,
    complexity: classification.estimatedComplexity,
    vision: classification.hasVisionContent,
    retrieval: classification.hasRetrievalNeed,
    memory: classification.hasMemoryNeed,
  });

  const planResult = buildPlan(classification, profile, config.policy, registry);

  if (!planResult.ok) {
    const status = planResult.error.type === 'capability-gap' ? 422 : 503;
    return {
      ok: false,
      error: {
        status,
        message: planResult.error.message,
        detail: planResult.error.message,
      },
    };
  }

  traceCtx?.record('plan', {
    planId: planResult.plan.id,
    stages: planResult.plan.stages.length,
    stageNodes: planResult.plan.stages.map((s) => `${s.capability}→${s.nodeId}`),
  });

  // Verify the final stage node's adapter supports streaming
  const finalStage = planResult.plan.stages[planResult.plan.stages.length - 1];
  const finalNode = registry.getById(finalStage.nodeId);
  const finalAdapter = finalNode ? getAdapter(finalNode.providerType) : undefined;

  if (!finalAdapter?.sendStreamingRequest) {
    // Check if any other node with this capability supports streaming
    let alternates = registry.findByCapabilities(finalStage.capabilities ?? [finalStage.capability])
      .filter((n) => n.id !== finalStage.nodeId);
    alternates = registry.filterByTags(alternates, profile.requiredTags, profile.excludedTags);
    if (config.policy.requireHealthy) {
      alternates = registry.filterByHealth(alternates, profile.allowDegradedNodes);
    }
    alternates = registry.sortByPriority(alternates);
    alternates = registry.applyProfileConstraints(alternates, profile);

    const hasStreamingAlternate = alternates.some((n) => {
      const a = getAdapter(n.providerType);
      return !!a?.sendStreamingRequest;
    });

    if (!hasStreamingAlternate) {
      // No streaming-capable nodes at all — fall back to non-streaming
      log.info('no streaming-capable nodes available, falling back to non-streaming', {
        nodeId: finalStage.nodeId,
      });
      const execResult = await executePlan(
        planResult.plan,
        request.messages,
        registry,
        config.policy,
        profile,
        {
          temperature: request.temperature,
          maxTokens: request.max_tokens,
          tools: request.tools,
          toolChoice: request.tool_choice,
        },
      );
      return convertToSSEStream(execResult, request.model);
    }
  }

  try {
    const execStart = Date.now();
    const result = await executePlanStreaming(
      planResult.plan,
      request.messages,
      registry,
      config.policy,
      profile,
      request.model,
      {
        temperature: request.temperature,
        maxTokens: request.max_tokens,
        tools: request.tools,
        toolChoice: request.tool_choice,
      },
    );

    traceCtx?.record('execute-complete', {
      durationMs: Date.now() - execStart,
      evidenceItems: result.evidence?.items.length ?? 0,
    });

    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('streaming execution failed, retrying final stage non-streaming', {
      error: message,
    });
    traceCtx?.record('error', { message });
    
    try {
      // Build a single-stage plan for just the final stage to avoid replaying intermediates
      const finalOnlyPlan: ExecutionPlan = {
        ...planResult.plan,
        id: `${planResult.plan.id}-fallback`,
        stages: [planResult.plan.stages[planResult.plan.stages.length - 1]],
      };
      // Note: If the final stage is 'evidence', change it to 'original' in the single-stage copy since there are no prior stages to provide evidence for this new plan execution context.
      if (finalOnlyPlan.stages[0].inputType === 'evidence') {
        finalOnlyPlan.stages[0] = { ...finalOnlyPlan.stages[0], inputType: 'original' };
      }

      const execResult = await executePlan(
        finalOnlyPlan,
        request.messages,
        registry,
        config.policy,
        profile,
        {
          temperature: request.temperature,
          maxTokens: request.max_tokens,
          tools: request.tools,
          toolChoice: request.tool_choice,
        },
      );
      return convertToSSEStream(execResult, request.model);
    } catch (fallbackErr) {
      return {
        ok: false,
        error: {
          status: 502,
          message: fallbackErr instanceof Error ? fallbackErr.message : 'Streaming fallback failed',
        },
      };
    }
  }
}

/** 
 * Convert an OrchestrationResult into a single-chunk ReadableStream 
 * for SSE compatibility.
 */
function convertToSSEStream(
  result: OrchestrationResult,
  model: string,
): StreamingRouterResult {
  const encoder = new TextEncoder();
  const content = result.response.content;
  const toolCalls = result.response.toolCalls;
  const chunkId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const roleChunk = {
        id: chunkId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' as const }, finish_reason: null }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));

      const toolCallDeltas = toolCalls?.map((tc, i) => ({ index: i, ...tc }));
      const contentChunk = {
        id: chunkId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { content, ...(toolCallDeltas ? { tool_calls: toolCallDeltas } : {}) },
            finish_reason: null,
          },
        ],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));

      const doneChunk = {
        id: chunkId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return {
    ok: true,
    result: { stream, plan: result.plan, evidence: result.evidence },
  };
}

/** Route an embedding request to an embedding-capable node */
export async function routeEmbedding(
  request: EmbeddingRequest,
  config: EmberSynthConfig,
  registry: NodeRegistry,
  traceCtx?: TraceContext,
): Promise<EmbeddingRouterResult> {
  const profile = resolveProfileFromModel(request.model, config);
  if (!profile) {
    return {
      ok: false,
      error: {
        status: 400,
        message: `Unknown model "${request.model}". Available: ${Object.keys(config.syntheticModels).join(', ')}`,
      },
    };
  }

  // Find embedding-capable nodes matching profile constraints
  let candidates = registry.findByCapabilities(['embedding']);
  candidates = registry.filterByTags(candidates, profile.requiredTags, profile.excludedTags);

  if (config.policy.requireHealthy) {
    candidates = registry.filterByHealth(candidates, profile.allowDegradedNodes);
  }

  candidates = registry.sortByPriority(candidates);

  // Apply full profile constraints
  candidates = registry.applyProfileConstraints(candidates, profile);

  if (candidates.length === 0) {
    return {
      ok: false,
      error: {
        status: 503,
        message: `No healthy embedding node available for profile "${profile.id}"`,
      },
    };
  }

  traceCtx?.record('plan', { capability: 'embedding', candidates: candidates.map((n) => n.id) });

  // Nova widens EmbeddingRequest.input to allow pre-tokenized numeric
  // arrays (`number[]` / `number[][]`). Embersynth's adapters expect
  // string[] only, so reject anything else early rather than letting
  // a numeric input reach a provider that can't handle it.
  const rawInput = Array.isArray(request.input) ? request.input : [request.input];
  if (rawInput.some((v) => typeof v !== 'string')) {
    return {
      ok: false,
      error: {
        status: 400,
        message: 'embersynth: pre-tokenized numeric embedding input is not supported yet',
      },
    };
  }
  const input = rawInput as string[];
  let lastError: string | undefined;
  let hasAdapterSupport = false;

  // Try candidates with fallback
  for (const node of candidates) {
    const adapter = getAdapter(node.providerType);
    if (!adapter?.sendEmbeddingRequest) continue;
    hasAdapterSupport = true;

    try {
      const result = await adapter.sendEmbeddingRequest(node, { input, model: node.modelId });
      registry.updateHealth(node.id, 'healthy');
      traceCtx?.record('execute-complete', { nodeId: node.id });
      return { ok: true, result, model: request.model, nodeId: node.id };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      registry.updateHealth(node.id, 'unhealthy', undefined, lastError);
      traceCtx?.record('error', { nodeId: node.id, message: lastError });
      // Continue to next candidate
    }
  }

  if (!hasAdapterSupport) {
    return {
      ok: false,
      error: {
        status: 501,
        message: 'No nodes available with embedding adapter support',
      },
    };
  }

  const finalError = `All embedding nodes failed. Last error: ${lastError}`;
  traceCtx?.record('error', { message: finalError });

  return {
    ok: false,
    error: {
      status: 502,
      message: finalError,
    },
  };
}

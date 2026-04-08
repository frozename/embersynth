import type {
  ChatCompletionRequest,
  EmberSynthConfig,
  OrchestrationResult,
  StreamingOrchestrationResult,
  EmbeddingRequest,
  EmbeddingAdapterResponse,
} from '../types/index.js';
import type { NodeRegistry } from '../registry/registry.js';
import type { TraceContext } from '../tracing/context.js';
import { classifyRequest } from './classifier.js';
import { buildPlan } from './planner.js';
import { executePlan, executePlanStreaming } from './executor.js';
import { resolveProfileFromModel } from '../config/loader.js';
import { getAdapter } from '../adapters/index.js';
import { log } from '../logger/index.js';

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
    return {
      ok: false,
      error: {
        status: 503,
        message: planResult.error.message,
        detail: `No available node for capability "${planResult.error.capability}" under profile "${profile.id}"`,
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
    return {
      ok: false,
      error: {
        status: 503,
        message: planResult.error.message,
        detail: `No available node for capability "${planResult.error.capability}" under profile "${profile.id}"`,
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
    // Fall back to non-streaming execution
    log.info('streaming not supported by final node adapter, falling back to non-streaming', {
      nodeId: finalStage.nodeId,
    });
    // Ensure no traceCtx is passed to route() on fallback to prevent duplicate events
    const result = await route(request, config, registry);
    if (!result.ok) return result;

    // Convert non-streaming result to a single-chunk stream
    const encoder = new TextEncoder();
    const content = result.result.response.content;
    const chunkId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const roleChunk = {
          id: chunkId, object: 'chat.completion.chunk', created, model: request.model,
          choices: [{ index: 0, delta: { role: 'assistant' as const }, finish_reason: null }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));

        const contentChunk = {
          id: chunkId, object: 'chat.completion.chunk', created, model: request.model,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`));

        const doneChunk = {
          id: chunkId, object: 'chat.completion.chunk', created, model: request.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    return {
      ok: true,
      result: { stream, plan: result.result.plan, evidence: result.result.evidence },
    };
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
      },
    );

    traceCtx?.record('execute-complete', {
      durationMs: Date.now() - execStart,
      evidenceItems: result.evidence?.items.length ?? 0,
    });

    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('streaming execution failed', {
      error: message,
    });
    traceCtx?.record('error', { message });
    return {
      ok: false,
      error: {
        status: 502,
        message: err instanceof Error ? err.message : 'Streaming execution failed',
      },
    };
  }
}

/** Route an embedding request to an embedding-capable node */
export async function routeEmbedding(
  request: EmbeddingRequest,
  config: EmberSynthConfig,
  registry: NodeRegistry,
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

  if (candidates.length === 0) {
    return {
      ok: false,
      error: {
        status: 503,
        message: `No healthy embedding node available for profile "${profile.id}"`,
      },
    };
  }

  const node = candidates[0];
  const adapter = getAdapter(node.providerType);

  if (!adapter?.sendEmbeddingRequest) {
    return {
      ok: false,
      error: {
        status: 501,
        message: `Adapter "${node.providerType}" does not support embeddings`,
      },
    };
  }

  const input = Array.isArray(request.input) ? request.input : [request.input];

  try {
    const result = await adapter.sendEmbeddingRequest(node, { input, model: node.modelId });
    registry.updateHealth(node.id, 'healthy');
    return { ok: true, result, model: request.model, nodeId: node.id };
  } catch (err) {
    registry.updateHealth(
      node.id,
      'unhealthy',
      undefined,
      err instanceof Error ? err.message : String(err),
    );
    return {
      ok: false,
      error: {
        status: 502,
        message: err instanceof Error ? err.message : 'Embedding request failed',
      },
    };
  }
}

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
  RoutingPolicy,
  RoutingProfile,
  Capability,
} from '../types/index.js';
import type { NodeRegistry } from '../registry/registry.js';
import { getAdapter } from '../adapters/index.js';
import { compressEvidence } from '../evidence/compressor.js';
import { withRequestId } from '../logger/index.js';

/** Execute a plan stage by stage, building up evidence */
export async function executePlan(
  plan: ExecutionPlan,
  originalMessages: ChatMessage[],
  registry: NodeRegistry,
  policy: RoutingPolicy,
  profile: RoutingProfile,
  options?: { temperature?: number; maxTokens?: number; tools?: any[]; toolChoice?: any },
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
      stage.capability,
      stage.nodeId,
      originalMessages,
      evidence,
      isLastStage,
      registry,
      policy,
      profile,
      failedNodeIds,
      options,
      rlog,
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
  options?: { temperature?: number; maxTokens?: number; tools?: any[]; toolChoice?: any },
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
      stage.capability,
      stage.nodeId,
      originalMessages,
      evidence,
      false,
      registry,
      policy,
      profile,
      failedNodeIds,
      options,
      rlog,
    );

    if (!result) {
      throw new Error(
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
  let streamNodeId = finalStage.nodeId;

  // Try primary node, then fallbacks
  const candidates = [finalStage.nodeId, ...registry.findByCapabilities([finalStage.capability])
    .filter(n => n.id !== finalStage.nodeId && n.enabled)
    .map(n => n.id)];

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
      // Test the connection with a non-streaming probe isn't practical for streaming,
      // so we'll create the generator and let the ReadableStream handle errors
      streamGen = candidateAdapter.sendStreamingRequest(candidateNode, request);
      streamNodeId = candidateId;
      break;
    } catch {
      failedStreamNodes.add(candidateId);
      registry.updateHealth(candidateId, 'unhealthy');
    }
  }

  if (!streamGen) {
    throw new Error(`No streaming-capable node available for capability "${finalStage.capability}"`);
  }

  rlog.info('streaming final stage', {
    capability: finalStage.capability,
    nodeId: streamNodeId,
  });

  const chunkId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const finalNodeId = streamNodeId;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      // Send initial chunk with role
      const initialChunk: ChatCompletionChunk = {
        id: chunkId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialChunk)}\n\n`));

      try {
        for await (const text of streamGen) {
          const chunk: ChatCompletionChunk = {
            id: chunkId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }

        // Send final chunk
        const doneChunk: ChatCompletionChunk = {
          id: chunkId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();

        registry.updateHealth(finalNodeId, 'healthy');
      } catch (err) {
        registry.updateHealth(
          finalNodeId,
          'unhealthy',
          undefined,
          err instanceof Error ? err.message : String(err),
        );
        controller.error(err);
      }
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
  capability: Capability,
  primaryNodeId: string,
  originalMessages: ChatMessage[],
  evidence: EvidenceBundle,
  isLastStage: boolean,
  registry: NodeRegistry,
  policy: RoutingPolicy,
  profile: RoutingProfile,
  failedNodeIds: Set<string>,
  options?: { temperature?: number; maxTokens?: number },
  rlog?: Log,
): Promise<StageResult | null> {
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
  const alternates = registry.findByCapabilities([capability]);
  const filtered = registry.filterByTags(
    alternates.filter((n) => !failedNodeIds.has(n.id)),
    profile.requiredTags,
    profile.excludedTags,
  );
  const healthy = policy.requireHealthy
    ? registry.filterByHealth(filtered, profile.allowDegradedNodes)
    : filtered;
  const sorted = registry.sortByPriority(healthy);

  for (const fallbackNode of sorted) {
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
  options?: { temperature?: number; maxTokens?: number },
  rlog?: Log,
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
  };

  if (!isLastStage) {
    request.systemPromptOverride = buildIntermediatePrompt(capability);
  }

  const maxAttempts = policy.maxRetries + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const stageStart = Date.now();

    try {
      const response = await adapter.sendRequest(node, request);
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

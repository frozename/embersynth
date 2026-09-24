// Namespace import (not named) so a stale @nova/contracts 0.1.x
// install degrades to `undefined` members we can detect — a named
// import of a missing export is a module-link failure at boot.
import * as nova from '@nova/contracts';
import { appendUsageBackground } from '@nova/mcp-shared';
import type {
  ProviderAdapter,
  NodeDefinition,
  AdapterRequest,
  AdapterResponse,
  EmbeddingAdapterRequest,
  EmbeddingAdapterResponse,
  HealthStatus,
  ChatMessage,
} from '../types/index.js';
import { TOOL_CALLS_MARKER, FINISH_REASON_MARKER } from './stream-markers.js';

/**
 * Default onUsageObservation handler — append the per-attempt token
 * usage to the family-wide JSONL sink. Nova fires exactly one
 * observation per call/stream attempt carrying only the counts the
 * upstream actually reported; we build a UsageRecordV2 in memory and
 * append ONLY the non-null `projectUsageRecordV2ToV1` result, so
 * unknown or partially-observed usage never becomes a fabricated
 * zero-filled row.
 *
 * V2 rows themselves are never appended — the V2 sink is a tracked
 * follow-up (P0.2 registrar seam).
 *
 * Fire-and-forget via queueMicrotask inside appendUsageBackground;
 * errors swallowed so a full disk can't disturb the response path.
 * Disabled when $EMBERSYNTH_DISABLE_USAGE is set (tests or strict
 * no-IO deployments).
 */
function defaultOnUsageObservation(
  node: NodeDefinition,
): nova.OpenAICompatOnUsageObservation | undefined {
  if (process.env.EMBERSYNTH_DISABLE_USAGE) return undefined;
  const project = (nova as { projectUsageRecordV2ToV1?: (r: nova.UsageRecordV2) => nova.UsageRecord | null })
    .projectUsageRecordV2ToV1;
  if (typeof project !== 'function') {
    throw new Error(
      '@nova/contracts >= 0.2.0 required: projectUsageRecordV2ToV1 is not exported (stale 0.1.x install?)',
    );
  }
  return (snapshot) => {
    const recordV2: nova.UsageRecordV2 = {
      v: 2,
      ts: new Date().toISOString(),
      provider: snapshot.provider,
      model: snapshot.model,
      kind: snapshot.kind,
      latency_ms: snapshot.latency_ms,
      observation: snapshot.observation,
      route: `embersynth:${node.id}`,
      ...(snapshot.request_id !== undefined ? { request_id: snapshot.request_id } : {}),
      ...(snapshot.attempt_id !== undefined ? { attempt_id: snapshot.attempt_id } : {}),
    };
    const v1 = project(recordV2);
    if (v1 === null) return;
    queueMicrotask(() => {
      appendUsageBackground({ record: v1 });
    });
  };
}

/**
 * Delegation note (M.3, 2026-04-18):
 *
 * This adapter is now a shim around `nova.createOpenAICompatProvider`
 * — Nova owns the HTTP + SSE parsing + auth + latency metadata across
 * every OpenAI-compat consumer in the family (llamactl, sirius,
 * embersynth). The orchestration-specific pre/post-processing stays
 * here:
 *
 *   * `prepareMessages` — evidence injection + systemPromptOverride
 *     merging run before Nova sees the request.
 *   * Streaming tool_calls reach the consumer as JSON-tagged strings
 *     (TOOL_CALLS_MARKER), preserving embersynth's on-wire encoding.
 *   * Health checks honor `node.health.endpoint` — Nova's healthPath
 *     option takes the configured path and probes it directly.
 */

function novaProviderForNode(
  node: NodeDefinition,
  overrides?: { healthPath?: string; skipUsage?: boolean },
): ReturnType<typeof nova.createOpenAICompatProvider> {
  const baseUrl = `${node.endpoint}/v1`;
  const token = node.auth.type === 'bearer' ? node.auth.token ?? '' : '';
  const extraHeaders: Record<string, string> = {};
  if (node.auth.type === 'header' && node.auth.headerName && node.auth.headerValue) {
    extraHeaders[node.auth.headerName] = node.auth.headerValue;
  }
  const onUsageObservation = overrides?.skipUsage ? undefined : defaultOnUsageObservation(node);
  return nova.createOpenAICompatProvider({
    name: node.id,
    baseUrl,
    apiKey: token,
    ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
    ...(overrides?.healthPath ? { healthPath: overrides.healthPath } : {}),
    ...(onUsageObservation ? { onUsageObservation } : {}),
  });
}

/**
 * Merge the caller's abort signal with the per-node request timeout
 * so either one cancels the upstream fetch. Returns the combined
 * signal plus a cancel() that disarms the timer.
 */
function mergedRequestSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal,
    cancel: () => clearTimeout(timeoutId),
  };
}

/** Shape AdapterRequest into Nova's UnifiedAiRequest. Applies
 *  embersynth's pre-processing first so evidence + system overrides
 *  show up in the wire body. */
function toNovaRequest(
  node: NodeDefinition,
  request: AdapterRequest,
  stream: boolean,
): nova.UnifiedAiRequest {
  const messages = prepareMessages(request);
  return {
    model: node.modelId ?? 'default',
    // Nova's ChatMessageSchema accepts the shape directly — embersynth's
    // ChatMessage is already aliased onto it (see src/types/index.ts).
    messages,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.tools ? { tools: request.tools } : {}),
    ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

/** Prepare messages with evidence injection */
function prepareMessages(request: AdapterRequest): ChatMessage[] {
  const messages = structuredClone(request.messages);

  if (request.evidence && request.evidence.items.length > 0) {
    const evidenceText = request.evidence.items
      .map((item) => `[${item.capability} from ${item.nodeId}]:\n${item.content}`)
      .join('\n\n');

    const systemMsg = messages.find((m) => m.role === 'system');
    if (systemMsg) {
      const currentContent = systemMsg.content == null
        ? ''
        : typeof systemMsg.content === 'string'
          ? systemMsg.content
          : systemMsg.content.map((p) => ('text' in p ? p.text : '')).join('');
      systemMsg.content = `${currentContent}\n\n## Evidence from prior stages:\n${evidenceText}`;
    } else {
      messages.unshift({
        role: 'system',
        content: `## Evidence from prior stages:\n${evidenceText}`,
      });
    }
  }

  if (request.systemPromptOverride) {
    const existing = messages.findIndex((m) => m.role === 'system');
    if (existing >= 0) {
      // Preserve any evidence already injected, prepend the override
      const currentContent = typeof messages[existing].content === 'string' ? messages[existing].content : '';
      const evidenceSection = currentContent.includes('## Evidence from prior stages:')
        ? '\n\n' + currentContent.slice(currentContent.indexOf('## Evidence from prior stages:'))
        : '';
      messages[existing] = { role: 'system', content: request.systemPromptOverride + evidenceSection };
    } else {
      messages.unshift({ role: 'system', content: request.systemPromptOverride });
    }
  }

  return messages;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible';

  async sendRequest(
    node: NodeDefinition,
    request: AdapterRequest,
    signal?: AbortSignal,
  ): Promise<AdapterResponse> {
    const provider = novaProviderForNode(node);
    const reqSignal = mergedRequestSignal(node.timeout.requestMs ?? 120_000, signal);
    try {
      const novaRes = await provider.createResponse(
        toNovaRequest(node, request, false),
        { signal: reqSignal.signal },
      );
      const choice = novaRes.choices[0];
      const content = choice?.message?.content;
      const contentStr = typeof content === 'string' ? content : '';
      return {
        content: contentStr,
        finishReason: choice?.finish_reason ?? 'stop',
        toolCalls: choice?.message?.tool_calls,
        usage: novaRes.usage
          ? {
              promptTokens: novaRes.usage.prompt_tokens,
              completionTokens: novaRes.usage.completion_tokens,
              totalTokens: novaRes.usage.total_tokens,
            }
          : undefined,
        raw: novaRes,
      };
    } finally {
      reqSignal.cancel();
    }
  }

  async *sendStreamingRequest(
    node: NodeDefinition,
    request: AdapterRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const provider = novaProviderForNode(node);
    const reqSignal = mergedRequestSignal(node.timeout.requestMs ?? 120_000, signal);
    let sawDone = false;
    try {
      const stream = provider.streamResponse!(toNovaRequest(node, request, true), reqSignal.signal);
      for await (const event of stream) {
        if (event.type === 'chunk') {
          const choice = event.chunk.choices[0];
          const delta = choice?.delta;
          const content = delta?.content;
          if (typeof content === 'string' && content.length > 0) yield content;
          const toolDelta = delta?.tool_calls;
          if (toolDelta && toolDelta.length > 0) {
            yield `${TOOL_CALLS_MARKER}${JSON.stringify(toolDelta)}`;
          }
          const finish = choice?.finish_reason;
          if (finish) yield `${FINISH_REASON_MARKER}${finish}`;
        } else if (event.type === 'error') {
          throw new Error(`Node ${node.id} returned ${event.error.code ?? ''}: ${event.error.message}`);
        } else if (event.type === 'done') {
          sawDone = true;
          // A truncated stream (transport EOF without [DONE] /
          // finish_reason) must not masquerade as a completed
          // response — e.g. a tool_call cut mid-arguments would
          // otherwise surface as a valid 'stop'.
          if (event.completion !== 'upstream') {
            throw new Error(
              `Node ${node.id} stream ended without upstream completion (completion=${event.completion ?? 'absent'})`,
            );
          }
        }
      }
      if (!sawDone) {
        throw new Error(`Node ${node.id} stream ended without a done event`);
      }
    } finally {
      reqSignal.cancel();
    }
  }

  async sendEmbeddingRequest(
    node: NodeDefinition,
    request: EmbeddingAdapterRequest,
    signal?: AbortSignal,
  ): Promise<EmbeddingAdapterResponse> {
    const provider = novaProviderForNode(node);
    const reqSignal = mergedRequestSignal(node.timeout.requestMs ?? 120_000, signal);
    try {
      const res = await provider.createEmbeddings!(
        {
          model: node.modelId ?? 'default',
          input: request.input,
        },
        { signal: reqSignal.signal },
      );
      const embeddings = res.data
        // Nova's embedding row allows number[] | string (base64). Embersynth
        // adapters consume numeric vectors only; if a provider returns
        // base64, upstream should pass `encoding_format: 'float'`.
        .map((row) => (Array.isArray(row.embedding) ? row.embedding : []));
      return {
        embeddings,
        usage: res.usage
          ? {
              promptTokens: res.usage.prompt_tokens,
              totalTokens: res.usage.total_tokens,
            }
          : undefined,
      };
    } catch (err) {
      // Nova throws on non-ok; surface the message unchanged so upstream
      // health tracking keeps the existing failure shape.
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      reqSignal.cancel();
    }
  }

  async checkHealth(node: NodeDefinition, _signal?: AbortSignal): Promise<HealthStatus> {
    // Nova's createOpenAICompatProvider accepts a healthPath override;
    // pass embersynth's configured /health (or whatever the operator
    // set) so Nova probes the right endpoint. baseUrl still includes
    // /v1, so we thread a path relative to /v1 — the fallback default
    // /health becomes /v1/health which most self-hosted servers also
    // expose; callers who need the true root /health can configure
    // the node with `health.endpoint: '/../health'` or point the node
    // at a bare host without /v1.
    const healthEndpoint = node.health.endpoint ?? '/health';
    const provider = novaProviderForNode(node, {
      healthPath: healthEndpoint,
      skipUsage: true, // health probes don't need usage logging
    });
    const start = Date.now();
    try {
      const h = await provider.healthCheck!();
      if (h.state === 'healthy') {
        return {
          nodeId: node.id,
          state: 'healthy',
          lastCheck: Date.now(),
          lastSuccess: Date.now(),
          consecutiveFailures: 0,
          latencyMs: h.latencyMs ?? Date.now() - start,
        };
      }
      return {
        nodeId: node.id,
        state: 'unhealthy',
        lastCheck: Date.now(),
        consecutiveFailures: 1,
        latencyMs: h.latencyMs ?? Date.now() - start,
        ...(h.error ? { error: h.error } : {}),
      };
    } catch (err) {
      return {
        nodeId: node.id,
        state: 'unhealthy',
        lastCheck: Date.now(),
        consecutiveFailures: 1,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

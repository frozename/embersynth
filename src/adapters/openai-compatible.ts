import { createOpenAICompatProvider } from '@nova/contracts';
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
  overrides?: { healthPath?: string },
): ReturnType<typeof createOpenAICompatProvider> {
  const baseUrl = `${node.endpoint}/v1`;
  const token = node.auth.type === 'bearer' ? node.auth.token ?? '' : '';
  const extraHeaders: Record<string, string> = {};
  if (node.auth.type === 'header' && node.auth.headerName && node.auth.headerValue) {
    extraHeaders[node.auth.headerName] = node.auth.headerValue;
  }
  return createOpenAICompatProvider({
    name: node.id,
    baseUrl,
    apiKey: token,
    ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
    ...(overrides?.healthPath ? { healthPath: overrides.healthPath } : {}),
  });
}

/** Shape AdapterRequest into Nova's UnifiedAiRequest. Applies
 *  embersynth's pre-processing first so evidence + system overrides
 *  show up in the wire body. */
function toNovaRequest(
  node: NodeDefinition,
  request: AdapterRequest,
  stream: boolean,
): import('@nova/contracts').UnifiedAiRequest {
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

  async sendRequest(node: NodeDefinition, request: AdapterRequest): Promise<AdapterResponse> {
    const provider = novaProviderForNode(node);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), node.timeout.requestMs ?? 120_000);
    try {
      const novaRes = await provider.createResponse(toNovaRequest(node, request, false));
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
      clearTimeout(timeoutId);
    }
  }

  async *sendStreamingRequest(
    node: NodeDefinition,
    request: AdapterRequest,
  ): AsyncGenerator<string> {
    const provider = novaProviderForNode(node);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), node.timeout.requestMs ?? 120_000);
    try {
      const stream = provider.streamResponse!(toNovaRequest(node, request, true), controller.signal);
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
          // Nova's `done` carries the finish_reason for consumers that
          // want a terminal marker; embersynth's chunk-level emission
          // above already covers this for tool_calls / stop. No-op.
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async sendEmbeddingRequest(
    node: NodeDefinition,
    request: EmbeddingAdapterRequest,
  ): Promise<EmbeddingAdapterResponse> {
    const provider = novaProviderForNode(node);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), node.timeout.requestMs ?? 120_000);
    try {
      const res = await provider.createEmbeddings!({
        model: node.modelId ?? 'default',
        input: request.input,
      });
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
      clearTimeout(timeoutId);
    }
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    // Nova's createOpenAICompatProvider accepts a healthPath override;
    // pass embersynth's configured /health (or whatever the operator
    // set) so Nova probes the right endpoint. baseUrl still includes
    // /v1, so we thread a path relative to /v1 — the fallback default
    // /health becomes /v1/health which most self-hosted servers also
    // expose; callers who need the true root /health can configure
    // the node with `health.endpoint: '/../health'` or point the node
    // at a bare host without /v1.
    const healthEndpoint = node.health.endpoint ?? '/health';
    const provider = novaProviderForNode(node, { healthPath: healthEndpoint });
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

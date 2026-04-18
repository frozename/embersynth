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
import type { ToolCallDelta } from '../types/tools.js';
import { buildHeaders } from './generic-http.js';
import { TOOL_CALLS_MARKER, FINISH_REASON_MARKER } from './stream-markers.js';

/**
 * Delegation note (M.3, 2026-04-18):
 *
 * `sendEmbeddingRequest` below delegates to nova.createOpenAICompatProvider
 * so the HTTP + auth + latency-metric bookkeeping for embeddings lives in
 * Nova alongside llamactl's and sirius's equivalents. Chat paths stay
 * embersynth-native because:
 *
 *   * `prepareMessages` performs evidence injection + systemPromptOverride
 *     merging — orchestration-layer concerns Nova shouldn't know about.
 *   * Nova's `streamResponse` chunks currently drop tool_call deltas
 *     (see nova/packages/contracts/src/providers/openai-compat.ts:158-167).
 *     Delegating streaming would regress tool-call-heavy workloads until
 *     Nova widens its delta shape.
 *   * Nova's `healthCheck` probes `/models` (auth-gated); embersynth's
 *     adapter respects per-node `health.endpoint` (cheaper /health on
 *     llama-servers). A future slice can expose Nova's health shape as
 *     an opt-in once that config toggle lands.
 *
 * This file's public surface (ProviderAdapter interface, AdapterResponse,
 * streaming markers) stays unchanged.
 */

function novaProviderForNode(node: NodeDefinition): ReturnType<typeof createOpenAICompatProvider> {
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
  });
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

/** Format messages for the wire — keeps structured content as-is, passes through tool fields */
function formatMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    const msg: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.tool_calls) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    return msg;
  });
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly type = 'openai-compatible';

  async sendRequest(node: NodeDefinition, request: AdapterRequest): Promise<AdapterResponse> {
    const url = `${node.endpoint}/v1/chat/completions`;
    const messages = prepareMessages(request);

    const body: Record<string, unknown> = {
      model: node.modelId ?? 'default',
      messages: formatMessages(messages),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: false,
    };
    if (request.tools) body.tools = request.tools;
    if (request.toolChoice) body.tool_choice = request.toolChoice;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), node.timeout.requestMs ?? 120_000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(node),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Node ${node.id} returned ${response.status}: ${text}`);
      }

      const data = (await response.json()) as {
        choices?: {
          message?: {
            content?: string;
            tool_calls?: import('../types/tools.js').ToolCall[];
          };
          finish_reason?: string;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const choice = data.choices?.[0];

      return {
        content: choice?.message?.content ?? '',
        finishReason: choice?.finish_reason ?? 'stop',
        toolCalls: choice?.message?.tool_calls,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens ?? 0,
              completionTokens: data.usage.completion_tokens ?? 0,
              totalTokens: data.usage.total_tokens ?? 0,
            }
          : undefined,
        raw: data,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async *sendStreamingRequest(
    node: NodeDefinition,
    request: AdapterRequest,
  ): AsyncGenerator<string> {
    const url = `${node.endpoint}/v1/chat/completions`;
    const messages = prepareMessages(request);

    const body: Record<string, unknown> = {
      model: node.modelId ?? 'default',
      messages: formatMessages(messages),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true,
    };
    if (request.tools) body.tools = request.tools;
    if (request.toolChoice) body.tool_choice = request.toolChoice;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), node.timeout.requestMs ?? 120_000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(node),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Node ${node.id} returned ${response.status}: ${text}`);
      }

      if (!response.body) {
        throw new Error(`Node ${node.id} returned no streaming body`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE lines
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // keep incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (trimmed === 'data: [DONE]') return;

            if (trimmed.startsWith('data: ')) {
              const jsonStr = trimmed.slice(6);
              try {
                const chunk = JSON.parse(jsonStr) as {
                  choices?: { delta?: { content?: string; tool_calls?: ToolCallDelta[] }; finish_reason?: string | null }[];
                };
                const choice = chunk.choices?.[0];
                const contentDelta = choice?.delta?.content;
                if (contentDelta) yield contentDelta;
                // Yield tool_call deltas as JSON-tagged strings for downstream parsing
                const toolDelta = choice?.delta?.tool_calls;
                if (toolDelta) yield `${TOOL_CALLS_MARKER}${JSON.stringify(toolDelta)}`;
                // Capture finish_reason for tool_calls
                if (choice?.finish_reason) yield `${FINISH_REASON_MARKER}${choice.finish_reason}`;
              } catch {
                // Skip malformed JSON chunks
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
          try {
            const chunk = JSON.parse(trimmed.slice(6));
            const choice = chunk.choices?.[0];
            if (choice?.delta?.content) yield choice.delta.content;
            if (choice?.delta?.tool_calls) yield `${TOOL_CALLS_MARKER}${JSON.stringify(choice.delta.tool_calls)}`;
            if (choice?.finish_reason) yield `${FINISH_REASON_MARKER}${choice.finish_reason}`;
          } catch { /* skip malformed */ }
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
    const healthEndpoint = node.health.endpoint ?? '/health';
    const url = `${node.endpoint}${healthEndpoint}`;
    const start = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      node.health.timeoutMs ?? 5_000,
    );

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: buildHeaders(node),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - start;

      return {
        nodeId: node.id,
        state: response.ok ? 'healthy' : 'unhealthy',
        lastCheck: Date.now(),
        lastSuccess: response.ok ? Date.now() : undefined,
        consecutiveFailures: response.ok ? 0 : 1,
        latencyMs,
      };
    } catch (err) {
      return {
        nodeId: node.id,
        state: 'unhealthy',
        lastCheck: Date.now(),
        consecutiveFailures: 1,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

import type {
  ProviderAdapter,
  NodeDefinition,
  AdapterRequest,
  AdapterResponse,
  HealthStatus,
} from '../types/index.js';

/**
 * Build auth + content-type headers for a given node definition.
 */
export function buildHeaders(node: NodeDefinition): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (node.auth.type === 'bearer' && node.auth.token) {
    headers['Authorization'] = `Bearer ${node.auth.token}`;
  } else if (node.auth.type === 'header' && node.auth.headerName && node.auth.headerValue) {
    headers[node.auth.headerName] = node.auth.headerValue;
  }
  return headers;
}

/**
 * Generic HTTP adapter for non-OpenAI-compatible services.
 * Sends a simplified JSON payload and expects a JSON response with a "content" field.
 *
 * This is a starting point for custom integrations — override or extend as needed.
 */
export class GenericHttpAdapter implements ProviderAdapter {
  readonly type = 'generic-http';

  async sendRequest(node: NodeDefinition, request: AdapterRequest): Promise<AdapterResponse> {
    const url = `${node.endpoint}/generate`;

    const body = {
      prompt: request.messages
        .map((m) => {
          const content =
            m.content == null
              ? ''
              : typeof m.content === 'string'
                ? m.content
                : m.content.map((p) => ('text' in p ? p.text : '[image]')).join('');
          return `${m.role}: ${content}`;
        })
        .join('\n'),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      evidence: request.evidence
        ? request.evidence.items.map((i) => ({
            source: i.nodeId,
            capability: i.capability,
            content: i.content,
          }))
        : undefined,
      system_prompt: request.systemPromptOverride ?? undefined,
      tools: request.tools ?? undefined,
      tool_choice: request.toolChoice ?? undefined,
    };

    const headers = buildHeaders(node);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), node.timeout.requestMs ?? 120_000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Node ${node.id} returned ${response.status}`);
      }

      const data = (await response.json()) as {
        content?: string;
        finish_reason?: string;
        tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
      };

      return {
        content: data.content ?? '',
        finishReason: data.finish_reason ?? 'stop',
        toolCalls: data.tool_calls?.length ? data.tool_calls : undefined,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    const url = `${node.endpoint}${node.health.endpoint ?? '/health'}`;
    const start = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), node.health.timeoutMs ?? 5_000);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: buildHeaders(node),
        signal: controller.signal,
      });

      return {
        nodeId: node.id,
        state: response.ok ? 'healthy' : 'unhealthy',
        lastCheck: Date.now(),
        lastSuccess: response.ok ? Date.now() : undefined,
        consecutiveFailures: response.ok ? 0 : 1,
        latencyMs: Date.now() - start,
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

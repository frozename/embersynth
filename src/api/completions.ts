import type { ChatCompletionRequest, ChatCompletionResponse, EmberSynthConfig } from '../types/index.js';
import type { NodeRegistry } from '../registry/registry.js';
import type { TraceContext } from '../tracing/context.js';
import { route, routeStreaming } from '../router/index.js';

function generateId(): string {
  return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function handleCompletions(
  req: Request,
  config: EmberSynthConfig,
  registry: NodeRegistry,
  traceCtx?: TraceContext,
): Promise<Response> {
  let body: ChatCompletionRequest;

  try {
    body = (await req.json()) as ChatCompletionRequest;
  } catch {
    return Response.json(
      { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  if (!body.model) {
    return Response.json(
      { error: { message: 'Missing required field: model', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json(
      { error: { message: 'Missing required field: messages', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  // ── Streaming path ──
  if (body.stream) {
    const result = await routeStreaming(body, config, registry, traceCtx);

    if (!result.ok) {
      return Response.json(
        { error: { message: result.error.message, type: 'api_error', detail: result.error.detail } },
        { status: result.error.status },
      );
    }

    const headers = new Headers({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-EmberSynth-Plan-Id': result.result.plan.id,
      'X-EmberSynth-Stages': String(result.result.plan.stages.length),
      'X-EmberSynth-Profile': result.result.plan.profileId,
    });

    return new Response(result.result.stream, { headers });
  }

  // ── Non-streaming path ──
  const result = await route(body, config, registry, traceCtx);

  if (!result.ok) {
    return Response.json(
      { error: { message: result.error.message, type: 'api_error', detail: result.error.detail } },
      { status: result.error.status },
    );
  }

  const { response: adapterResponse, plan } = result.result;

  const response: ChatCompletionResponse = {
    id: generateId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: adapterResponse.content,
          ...(adapterResponse.toolCalls ? { tool_calls: adapterResponse.toolCalls } : {}),
        },
        finish_reason: adapterResponse.finishReason,
      },
    ],
    usage: adapterResponse.usage
      ? {
          prompt_tokens: adapterResponse.usage.promptTokens,
          completion_tokens: adapterResponse.usage.completionTokens,
          total_tokens: adapterResponse.usage.totalTokens,
        }
      : undefined,
  };

  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.set('X-EmberSynth-Plan-Id', plan.id);
  headers.set('X-EmberSynth-Stages', String(plan.stages.length));
  headers.set('X-EmberSynth-Profile', plan.profileId);
  headers.set('X-EmberSynth-Duration-Ms', String(result.result.totalDurationMs));

  return new Response(JSON.stringify(response), { headers });
}

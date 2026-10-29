import type { EmbeddingRequest, EmbeddingResponse, EmberSynthConfig } from '../types/index.js';
import type { NodeRegistry } from '../registry/registry.js';
import type { TraceContext } from '../tracing/context.js';
import { routeEmbedding } from '../router/index.js';

/**
 * #36: input must be a string or an array of strings. Checked before routing,
 * so a malformed request never reaches a node or counts against its health.
 */
function isValidEmbeddingInput(input: unknown): boolean {
  if (typeof input === 'string') return true;
  return Array.isArray(input) && input.every((v: unknown) => typeof v === 'string');
}

export async function handleEmbeddings(
  req: Request,
  config: EmberSynthConfig,
  registry: NodeRegistry,
  traceCtx?: TraceContext,
): Promise<Response> {
  let parsed: unknown;

  try {
    parsed = await req.json();
  } catch {
    return Response.json(
      { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  // #36: a JSON null body would make `body.model` throw and turn into a 500.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return Response.json(
      { error: { message: 'Request body must be a JSON object', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  const body = parsed as EmbeddingRequest;

  if (!body.model) {
    return Response.json(
      { error: { message: 'Missing required field: model', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
    return Response.json(
      { error: { message: 'Missing required field: input', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  if (!isValidEmbeddingInput(body.input)) {
    return Response.json(
      { error: { message: 'Invalid field: input', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  traceCtx?.record('classify', { model: body.model, inputs: inputs.length });

  const result = await routeEmbedding(body, config, registry, traceCtx, req.signal);

  if (!result.ok) {
    return Response.json(
      { error: { message: result.error.message, type: 'api_error', detail: result.error.detail } },
      { status: result.error.status },
    );
  }

  const response: EmbeddingResponse = {
    object: 'list',
    data: result.result.embeddings.map((embedding, index) => ({
      object: 'embedding' as const,
      embedding,
      index,
    })),
    model: body.model,
    usage: {
      prompt_tokens: result.result.usage?.promptTokens ?? 0,
      total_tokens: result.result.usage?.totalTokens ?? 0,
    },
  };

  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.set('X-EmberSynth-Node-Id', result.nodeId);

  return new Response(JSON.stringify(response), { headers });
}

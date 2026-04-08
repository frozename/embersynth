import type { EmbeddingRequest, EmbeddingResponse, EmberSynthConfig } from '../types/index.js';
import type { NodeRegistry } from '../registry/registry.js';
import { routeEmbedding } from '../router/index.js';

export async function handleEmbeddings(
  req: Request,
  config: EmberSynthConfig,
  registry: NodeRegistry,
): Promise<Response> {
  let body: EmbeddingRequest;

  try {
    body = (await req.json()) as EmbeddingRequest;
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

  if (!body.input) {
    return Response.json(
      { error: { message: 'Missing required field: input', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  const result = await routeEmbedding(body, config, registry);

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

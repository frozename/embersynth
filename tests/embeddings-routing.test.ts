import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleEmbeddings } from '../src/api/embeddings.js';
import { registerAdapter, resetAdapters } from '../src/adapters/index.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { NodeRegistry } from '../src/registry/registry.js';
import { routeEmbedding } from '../src/router/index.js';
import type { EmbeddingRouterResult, RouterError } from '../src/router/index.js';
import type {
  AdapterRequest,
  AdapterResponse,
  Capability,
  EmberSynthConfig,
  EmbeddingAdapterRequest,
  EmbeddingAdapterResponse,
  EmbeddingResponse,
  HealthStatus,
  NodeDefinition,
  ProviderAdapter,
} from '../src/types/index.js';

// #22: pin routeEmbedding's priority fallback, health marking and error
// statuses, and how handleEmbeddings validates the body and maps the result.
// The adapters are in-process fakes; nothing touches the network.

let tempDir = '';
let previousEvidencePath: string | undefined;

interface EmbedCall {
  nodeId: string;
  request: EmbeddingAdapterRequest;
}

type ScriptEntry = EmbeddingAdapterResponse | Error;

/** Records every embedding call and answers or throws per node id from `script`. */
class EmbedProbeAdapter implements ProviderAdapter {
  readonly type = 'embed-probe';
  readonly calls: EmbedCall[] = [];
  private readonly script: Record<string, ScriptEntry>;

  constructor(script: Record<string, ScriptEntry>) {
    this.script = script;
  }

  async sendRequest(_node: NodeDefinition, _request: AdapterRequest, _signal?: AbortSignal): Promise<AdapterResponse> {
    throw new Error('embed-probe: chat is not used');
  }

  async sendEmbeddingRequest(
    node: NodeDefinition,
    request: EmbeddingAdapterRequest,
    _signal?: AbortSignal,
  ): Promise<EmbeddingAdapterResponse> {
    this.calls.push({ nodeId: node.id, request });
    const entry = this.script[node.id];
    if (entry === undefined) {
      throw new Error(`embed-probe: no script for node ${node.id}`);
    }
    if (entry instanceof Error) {
      throw entry;
    }
    return entry;
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    return { nodeId: node.id, state: 'healthy', consecutiveFailures: 0 };
  }
}

/** A registered adapter that has no sendEmbeddingRequest. */
class ChatOnlyAdapter implements ProviderAdapter {
  readonly type = 'chat-only';

  async sendRequest(_node: NodeDefinition, _request: AdapterRequest, _signal?: AbortSignal): Promise<AdapterResponse> {
    throw new Error('chat-only: chat is not used');
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    return { nodeId: node.id, state: 'healthy', consecutiveFailures: 0 };
  }
}

type ErrorBody = { error: { message: string; type: string } };

function makeNode(
  id: string,
  priority: number,
  capabilities: Capability[] = ['embedding'],
  providerType = 'embed-probe',
): NodeDefinition {
  return {
    id,
    label: `Embed probe ${id}`,
    endpoint: 'http://127.0.0.1:9',
    transport: 'http',
    enabled: true,
    capabilities,
    tags: ['local'],
    auth: { type: 'none' },
    health: {},
    timeout: {},
    priority,
    modelId: `m-${id}`,
    providerType,
  };
}

interface Harness {
  registry: NodeRegistry;
  config: EmberSynthConfig;
}

/** Registers the adapters and loads `nodes` into a fresh registry, with DEFAULT_CONFIG otherwise. */
function setup(nodes: NodeDefinition[], adapters: ProviderAdapter[]): Harness {
  for (const adapter of adapters) {
    registerAdapter(adapter);
  }
  const registry = new NodeRegistry();
  registry.load(nodes);
  return { registry, config: { ...DEFAULT_CONFIG, nodes } };
}

function errorOf(result: EmbeddingRouterResult): RouterError {
  if (result.ok) {
    throw new Error(`expected routeEmbedding to fail, got node ${result.nodeId}`);
  }
  return result.error;
}

function post(body: string): Request {
  return new Request('http://local/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

/** Asserts a JSON reply with `status` and returns its parsed error body. */
async function readError(res: Response, status: number): Promise<ErrorBody> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type') ?? '').toContain('application/json');
  return (await res.json()) as ErrorBody;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'embersynth-embed-routing-'));
  previousEvidencePath = process.env.EMBERSYNTH_EVIDENCE_PATH;
  process.env.EMBERSYNTH_EVIDENCE_PATH = join(tempDir, 'evidence.jsonl');
});

afterEach(() => {
  resetAdapters();
  if (previousEvidencePath === undefined) {
    delete process.env.EMBERSYNTH_EVIDENCE_PATH;
  } else {
    process.env.EMBERSYNTH_EVIDENCE_PATH = previousEvidencePath;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('routeEmbedding (#22)', () => {
  test('an unknown model returns 400 and calls no adapter', async () => {
    const adapter = new EmbedProbeAdapter({ A: { embeddings: [[0.1]] } });
    const { registry, config } = setup([makeNode('A', 1)], [adapter]);

    const error = errorOf(await routeEmbedding({ model: 'no-such-model', input: 'hello' }, config, registry));

    expect(error.status).toBe(400);
    expect(error.message).toStartWith('Unknown model "no-such-model". Available: ');
    expect(error.message).toContain('fusion-auto');
    expect(adapter.calls).toHaveLength(0);
  });

  test('no embedding-capable node returns 503 and calls no adapter', async () => {
    const adapter = new EmbedProbeAdapter({ A: { embeddings: [[0.1]] } });
    const { registry, config } = setup([makeNode('A', 1, ['reasoning'])], [adapter]);

    const error = errorOf(await routeEmbedding({ model: 'fusion-auto', input: 'hello' }, config, registry));

    expect(error.status).toBe(503);
    expect(error.message).toBe('No healthy embedding node available for profile "auto"');
    expect(adapter.calls).toHaveLength(0);
  });

  test('pre-tokenized numeric input returns 400 and calls no adapter', async () => {
    const adapter = new EmbedProbeAdapter({ A: { embeddings: [[0.1]] } });
    const { registry, config } = setup([makeNode('A', 1)], [adapter]);

    const error = errorOf(await routeEmbedding({ model: 'fusion-auto', input: [1, 2] }, config, registry));

    expect(error.status).toBe(400);
    expect(error.message).toBe('embersynth: pre-tokenized numeric embedding input is not supported yet');
    expect(adapter.calls).toHaveLength(0);
  });

  test('a candidate whose providerType has no registered adapter returns 501', async () => {
    const adapter = new EmbedProbeAdapter({ A: { embeddings: [[0.1]] } });
    const { registry, config } = setup([makeNode('A', 1, ['embedding'], 'embed-unregistered')], [adapter]);

    const error = errorOf(await routeEmbedding({ model: 'fusion-auto', input: 'hello' }, config, registry));

    expect(error.status).toBe(501);
    expect(error.message).toBe('No nodes available with embedding adapter support');
    expect(adapter.calls).toHaveLength(0);
  });

  test('a candidate whose adapter has no sendEmbeddingRequest returns 501', async () => {
    const { registry, config } = setup([makeNode('A', 1, ['embedding'], 'chat-only')], [new ChatOnlyAdapter()]);

    const error = errorOf(await routeEmbedding({ model: 'fusion-auto', input: 'hello' }, config, registry));

    expect(error.status).toBe(501);
    expect(error.message).toBe('No nodes available with embedding adapter support');
  });

  test('falls back from a failing node to the next by priority and degrades only the failing node', async () => {
    const adapter = new EmbedProbeAdapter({ A: new Error('boom-A'), B: { embeddings: [[0.5]] } });
    const { registry, config } = setup([makeNode('B', 2), makeNode('A', 1)], [adapter]);

    const result = await routeEmbedding({ model: 'fusion-auto', input: 'hello' }, config, registry);

    expect(adapter.calls).toEqual([
      { nodeId: 'A', request: { input: ['hello'], model: 'm-A' } },
      { nodeId: 'B', request: { input: ['hello'], model: 'm-B' } },
    ]);
    if (!result.ok) {
      throw new Error(`expected ok, got ${result.error.message}`);
    }
    expect(result.nodeId).toBe('B');
    expect(result.model).toBe('fusion-auto');
    expect(result.result.embeddings).toEqual([[0.5]]);
    expect(registry.getHealth('A')?.state).toBe('degraded');
    expect(registry.getHealth('A')?.consecutiveFailures).toBe(1);
    expect(registry.getHealth('A')?.error).toBe('boom-A');
    expect(registry.getHealth('B')?.state).toBe('healthy');
    expect(registry.getHealth('B')?.consecutiveFailures).toBe(0);
  });

  test('a node degraded by an earlier failure is skipped while requireHealthy is on', async () => {
    const adapter = new EmbedProbeAdapter({ A: new Error('boom-A'), B: { embeddings: [[0.5]] } });
    const { registry, config } = setup([makeNode('A', 1), makeNode('B', 2)], [adapter]);

    await routeEmbedding({ model: 'fusion-auto', input: 'first' }, config, registry);
    const second = await routeEmbedding({ model: 'fusion-auto', input: 'second' }, config, registry);

    expect(adapter.calls.map((call) => call.nodeId)).toEqual(['A', 'B', 'B']);
    expect(second.ok ? second.nodeId : second.error.message).toBe('B');
    expect(registry.getHealth('A')?.consecutiveFailures).toBe(1);
  });

  test('when every node fails, returns 502 with the last error', async () => {
    const adapter = new EmbedProbeAdapter({ A: new Error('boom-A'), B: new Error('boom-B') });
    const { registry, config } = setup([makeNode('A', 1), makeNode('B', 2)], [adapter]);

    const error = errorOf(await routeEmbedding({ model: 'fusion-auto', input: ['x'] }, config, registry));

    expect(error.status).toBe(502);
    expect(error.message).toBe('All embedding nodes failed. Last error: boom-B');
    expect(adapter.calls.map((call) => call.nodeId)).toEqual(['A', 'B']);
    expect(registry.getHealth('A')?.state).toBe('degraded');
    expect(registry.getHealth('B')?.state).toBe('degraded');
    expect(registry.getHealth('B')?.error).toBe('boom-B');
  });
});

describe('handleEmbeddings (#22)', () => {
  test('a body that is not JSON returns 400 invalid_request_error', async () => {
    const adapter = new EmbedProbeAdapter({ A: { embeddings: [[0.1]] } });
    const { registry, config } = setup([makeNode('A', 1)], [adapter]);

    const body = await readError(await handleEmbeddings(post('not json'), config, registry), 400);

    expect(body.error).toEqual({ message: 'Invalid JSON body', type: 'invalid_request_error' });
    expect(adapter.calls).toHaveLength(0);
  });

  test('a missing model returns 400 invalid_request_error', async () => {
    const adapter = new EmbedProbeAdapter({ A: { embeddings: [[0.1]] } });
    const { registry, config } = setup([makeNode('A', 1)], [adapter]);

    const res = await handleEmbeddings(post(JSON.stringify({ input: 'hello' })), config, registry);
    const body = await readError(res, 400);

    expect(body.error).toEqual({ message: 'Missing required field: model', type: 'invalid_request_error' });
    expect(adapter.calls).toHaveLength(0);
  });

  test('a missing or empty input returns 400 invalid_request_error', async () => {
    const adapter = new EmbedProbeAdapter({ A: { embeddings: [[0.1]] } });
    const { registry, config } = setup([makeNode('A', 1)], [adapter]);

    for (const payload of [{ model: 'fusion-auto' }, { model: 'fusion-auto', input: '' }]) {
      const res = await handleEmbeddings(post(JSON.stringify(payload)), config, registry);
      const body = await readError(res, 400);
      expect(body.error).toEqual({ message: 'Missing required field: input', type: 'invalid_request_error' });
    }
    expect(adapter.calls).toHaveLength(0);
  });

  test('a success maps embeddings to indexed rows, the request model, usage and the node header', async () => {
    const adapter = new EmbedProbeAdapter({
      A: { embeddings: [[0.1], [0.2]], usage: { promptTokens: 3, totalTokens: 5 } },
    });
    const { registry, config } = setup([makeNode('A', 1)], [adapter]);

    const res = await handleEmbeddings(post(JSON.stringify({ model: 'fusion-auto', input: ['a', 'b'] })), config, registry);

    expect(res.status).toBe(200);
    expect(res.headers.get('X-EmberSynth-Node-Id')).toBe('A');
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const body = (await res.json()) as EmbeddingResponse;
    expect(body).toEqual({
      object: 'list',
      data: [
        { object: 'embedding', embedding: [0.1], index: 0 },
        { object: 'embedding', embedding: [0.2], index: 1 },
      ],
      model: 'fusion-auto',
      usage: { prompt_tokens: 3, total_tokens: 5 },
    });
    expect(adapter.calls).toEqual([{ nodeId: 'A', request: { input: ['a', 'b'], model: 'm-A' } }]);
  });

  test('an adapter reply without usage maps to zero token counts', async () => {
    const adapter = new EmbedProbeAdapter({ A: { embeddings: [[0.1]] } });
    const { registry, config } = setup([makeNode('A', 1)], [adapter]);

    const res = await handleEmbeddings(post(JSON.stringify({ model: 'fusion-auto', input: 'a' })), config, registry);

    expect(res.status).toBe(200);
    const body = (await res.json()) as EmbeddingResponse;
    expect(body.usage).toEqual({ prompt_tokens: 0, total_tokens: 0 });
  });

  test('a router failure passes its status through as api_error', async () => {
    const adapter = new EmbedProbeAdapter({ A: { embeddings: [[0.1]] } });
    const { registry, config } = setup([makeNode('A', 1, ['reasoning'])], [adapter]);

    const res = await handleEmbeddings(post(JSON.stringify({ model: 'fusion-auto', input: 'a' })), config, registry);
    const body = await readError(res, 503);

    expect(body.error.type).toBe('api_error');
    expect(body.error.message).toBe('No healthy embedding node available for profile "auto"');
    expect(adapter.calls).toHaveLength(0);
  });
});

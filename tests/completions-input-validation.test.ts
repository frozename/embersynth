import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCompletions } from '../src/api/completions.js';
import { handleResponses } from '../src/api/responses.js';
import { registerAdapter, resetAdapters } from '../src/adapters/index.js';
import { NodeRegistry } from '../src/registry/registry.js';
import { DEFAULT_PROFILES, DEFAULT_POLICY, SYNTHETIC_MODEL_MAP } from '../src/config/defaults.js';
import type { ProviderAdapter, NodeDefinition, AdapterRequest, AdapterResponse, HealthStatus, EmberSynthConfig } from '../src/types/index.js';

// #39: malformed message elements must be rejected with 400 before routing.
// classifyRequest used to throw on them (HTTP 500) or forward them upstream.

let tempDir = '';
let previousEvidencePath: string | undefined;
let upstreamCalls = 0;

class CountingAdapter implements ProviderAdapter {
  readonly type = 'mock-completions-validation';

  async sendRequest(_node: NodeDefinition, _request: AdapterRequest): Promise<AdapterResponse> {
    upstreamCalls++;
    return { content: 'ok', finishReason: 'stop' };
  }

  async *sendStreamingRequest(_node: NodeDefinition, _request: AdapterRequest): AsyncGenerator<string> {
    upstreamCalls++;
    yield 'ok';
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    return { nodeId: node.id, state: 'healthy', consecutiveFailures: 0 };
  }
}

interface Outcome {
  status: number | string;
  message: string;
  type: string;
}

type Handler = (req: Request, config: EmberSynthConfig, registry: NodeRegistry) => Promise<Response>;

function makeNode(): NodeDefinition {
  return {
    id: 'completions-input-node',
    label: 'Completions input node',
    endpoint: 'http://127.0.0.1:9',
    transport: 'http',
    enabled: true,
    capabilities: ['reasoning'],
    tags: ['local'],
    auth: { type: 'none' },
    health: {},
    timeout: {},
    priority: 10,
    modelId: 'mock-input',
    providerType: 'mock-completions-validation',
  };
}

function makeConfig(node: NodeDefinition): EmberSynthConfig {
  return {
    server: { host: '127.0.0.1', port: 0 },
    nodes: [node],
    profiles: DEFAULT_PROFILES,
    policy: { ...DEFAULT_POLICY, requireHealthy: false, retryDelayMs: 0 },
    syntheticModels: SYNTHETIC_MODEL_MAP,
  };
}

function makeRegistry(node: NodeDefinition): NodeRegistry {
  const registry = new NodeRegistry();
  registry.load([node]);
  return registry;
}

// Calls the handler in-process. A throw becomes a 'threw ...' status, so an
// unfixed handler fails the assertion instead of crashing the test. A 200 body
// is drained so a streamed reply reaches the adapter before upstreamCalls is read.
async function post(handler: Handler, path: string, payload: Record<string, unknown>): Promise<Outcome> {
  const node = makeNode();
  const req = new Request(`http://x${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  try {
    const res = await handler(req, makeConfig(node), makeRegistry(node));
    if (res.status === 200) {
      await res.text();
      return { status: 200, message: '', type: '' };
    }
    const parsed = (await res.json()) as { error: { message: string; type: string } };
    return { status: res.status, message: parsed.error.message, type: parsed.error.type };
  } catch (err) {
    return { status: `threw ${String(err)}`, message: '', type: '' };
  }
}

const malformed: [string, unknown[]][] = [
  ['a null element', [null]],
  ['a number element', [42]],
  ['a string element', ['hi']],
  ['a message without a string role', [{ content: 'hi' }]],
  ['numeric content', [{ role: 'user', content: 42 }]],
  ['plain-object content', [{ role: 'user', content: {} }]],
  ['a null content part', [{ role: 'user', content: [null] }]],
  ['a content part without a string type', [{ role: 'user', content: [{ text: 'hi' }] }]],
];

const wellFormed: [string, unknown[]][] = [
  ['string content', [{ role: 'user', content: 'hi' }]],
  ['a text content-part array', [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]],
  [
    'null content on an assistant tool_calls message',
    [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      },
      { role: 'tool', content: 'done', tool_call_id: 'call-1' },
    ],
  ],
  ['a message with no content key', [{ role: 'user', content: 'hi' }, { role: 'assistant' }]],
];

const streamModes: boolean[] = [false, true];

describe('/v1/chat/completions messages validation', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'embersynth-completions-input-'));
    previousEvidencePath = process.env.EMBERSYNTH_EVIDENCE_PATH;
    process.env.EMBERSYNTH_EVIDENCE_PATH = join(tempDir, 'evidence.jsonl');
    upstreamCalls = 0;
    registerAdapter(new CountingAdapter());
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

  for (const [label, messages] of malformed) {
    for (const stream of streamModes) {
      test(`rejects ${label} with 400 and no upstream call (stream ${String(stream)})`, async () => {
        const outcome = await post(handleCompletions, '/v1/chat/completions', { model: 'fusion-auto', messages, stream });
        expect(outcome).toEqual({ status: 400, message: 'Invalid field: messages', type: 'invalid_request_error' });
        expect(upstreamCalls).toBe(0);
      });
    }
  }

  for (const [label, messages] of wellFormed) {
    for (const stream of streamModes) {
      test(`accepts ${label} with exactly one upstream call (stream ${String(stream)})`, async () => {
        const outcome = await post(handleCompletions, '/v1/chat/completions', { model: 'fusion-auto', messages, stream });
        expect(outcome).toEqual({ status: 200, message: '', type: '' });
        expect(upstreamCalls).toBe(1);
      });
    }
  }

  test('keeps the missing-messages message for an empty array', async () => {
    const outcome = await post(handleCompletions, '/v1/chat/completions', { model: 'fusion-auto', messages: [] });
    expect(outcome).toEqual({ status: 400, message: 'Missing required field: messages', type: 'invalid_request_error' });
    expect(upstreamCalls).toBe(0);
  });

  for (const stream of streamModes) {
    test(`/v1/responses rejects numeric content in array input with 400 (stream ${String(stream)})`, async () => {
      const outcome = await post(handleResponses, '/v1/responses', {
        model: 'fusion-auto',
        input: [{ role: 'user', content: 42 }],
        stream,
      });
      expect(outcome).toEqual({ status: 400, message: 'Invalid field: input', type: 'invalid_request_error' });
      expect(upstreamCalls).toBe(0);
    });
  }
});

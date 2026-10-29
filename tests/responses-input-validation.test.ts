import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleResponses } from '../src/api/responses.js';
import { registerAdapter, resetAdapters } from '../src/adapters/index.js';
import { NodeRegistry } from '../src/registry/registry.js';
import { DEFAULT_PROFILES, DEFAULT_POLICY, SYNTHETIC_MODEL_MAP } from '../src/config/defaults.js';
import type { ProviderAdapter, NodeDefinition, AdapterRequest, AdapterResponse, HealthStatus, EmberSynthConfig } from '../src/types/index.js';

let tempDir = '';
let previousEvidencePath: string | undefined;
let upstreamCalls = 0;

class CountingAdapter implements ProviderAdapter {
  readonly type = 'mock-input-validation';

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

function makeNode(): NodeDefinition {
  return {
    id: 'input-node',
    label: 'Input node',
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
    providerType: 'mock-input-validation',
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
// unfixed handler fails the assertion instead of crashing the test.
async function post(payload: Record<string, unknown>): Promise<Outcome> {
  const node = makeNode();
  const req = new Request('http://x/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  try {
    const res = await handleResponses(req, makeConfig(node), makeRegistry(node));
    if (res.status === 200) return { status: 200, message: '', type: '' };
    const parsed = (await res.json()) as { error: { message: string; type: string } };
    return { status: res.status, message: parsed.error.message, type: parsed.error.type };
  } catch (err) {
    return { status: `threw ${String(err)}`, message: '', type: '' };
  }
}

const rejected: [string, unknown, string][] = [
  ['a number', 42, 'Invalid field: input'],
  ['a plain object', {}, 'Invalid field: input'],
  ['an array holding null', [null], 'Invalid field: input'],
  ['an array of strings', ['hi'], 'Invalid field: input'],
  ['a message without a string role', [{ content: 'hi' }], 'Invalid field: input'],
  ['an empty array', [], 'Missing required field: input'],
  ['an empty string', '', 'Missing required field: input'],
];

describe('/v1/responses input validation', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'embersynth-resp-input-'));
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

  for (const [label, input, message] of rejected) {
    test(`rejects ${label} with 400 and no upstream call`, async () => {
      const outcome = await post({ model: 'fusion-auto', input });
      expect(outcome).toEqual({ status: 400, message, type: 'invalid_request_error' });
      expect(upstreamCalls).toBe(0);
    });
  }

  test('keeps the missing-input message when input is absent', async () => {
    const outcome = await post({ model: 'fusion-auto' });
    expect(outcome).toEqual({ status: 400, message: 'Missing required field: input', type: 'invalid_request_error' });
    expect(upstreamCalls).toBe(0);
  });

  test('rejects malformed streaming input before routing', async () => {
    const outcome = await post({ model: 'fusion-auto', input: [null], stream: true });
    expect(outcome).toEqual({ status: 400, message: 'Invalid field: input', type: 'invalid_request_error' });
    expect(upstreamCalls).toBe(0);
  });

  test('accepts a string input with exactly one upstream call', async () => {
    const outcome = await post({ model: 'fusion-auto', input: 'hi' });
    expect(outcome.status).toBe(200);
    expect(upstreamCalls).toBe(1);
  });

  test('accepts a message array with exactly one upstream call', async () => {
    const outcome = await post({ model: 'fusion-auto', input: [{ role: 'user', content: 'hi' }] });
    expect(outcome.status).toBe(200);
    expect(upstreamCalls).toBe(1);
  });
});

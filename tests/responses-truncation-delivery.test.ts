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

class TruncatingAdapter implements ProviderAdapter {
  readonly type = 'mock-truncating';

  async sendRequest(_node: NodeDefinition, _request: AdapterRequest): Promise<AdapterResponse> {
    return { content: 'Hello trunc', finishReason: 'stop' };
  }

  async *sendStreamingRequest(_node: NodeDefinition, _request: AdapterRequest): AsyncGenerator<string> {
    yield 'Hello';
    yield ' trunc';
    throw new Error('truncated');
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    return { nodeId: node.id, state: 'healthy', consecutiveFailures: 0 };
  }
}

class CompleteAdapter implements ProviderAdapter {
  readonly type = 'mock-complete';

  async sendRequest(_node: NodeDefinition, _request: AdapterRequest): Promise<AdapterResponse> {
    return { content: 'Hello world', finishReason: 'stop' };
  }

  async *sendStreamingRequest(_node: NodeDefinition, _request: AdapterRequest): AsyncGenerator<string> {
    yield 'Hello';
    yield ' world';
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    return { nodeId: node.id, state: 'healthy', consecutiveFailures: 0 };
  }
}

function makeNode(providerType: string): NodeDefinition {
  return {
    id: 'resp-node',
    label: 'Resp node',
    endpoint: 'http://127.0.0.1:9',
    transport: 'http',
    enabled: true,
    capabilities: ['reasoning'],
    tags: ['local'],
    auth: { type: 'none' },
    health: {},
    timeout: {},
    priority: 10,
    modelId: 'mock-resp',
    providerType,
  };
}

function makeConfig(node: NodeDefinition): EmberSynthConfig {
  return {
    server: { host: '127.0.0.1', port: 0 },
    nodes: [node],
    profiles: DEFAULT_PROFILES,
    policy: { ...DEFAULT_POLICY, requireHealthy: false, retryDelayMs: 50 },
    syntheticModels: SYNTHETIC_MODEL_MAP,
  };
}

function makeRegistry(node: NodeDefinition): NodeRegistry {
  const registry = new NodeRegistry();
  registry.load([node]);
  return registry;
}

function makeRequest(): Request {
  return new Request('http://local/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'fusion-auto', input: 'hi', stream: true }),
  });
}

// Ordering barrier, not a sleep: the fake adapters do only microtask work, so
// after this every chunk the unfixed start() would enqueue has been enqueued
// and the error has already landed.
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function drain(res: Response): Promise<{ text: string; failure: unknown }> {
  let text = '';
  let failure: unknown = null;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    failure = err;
  }
  return { text, failure };
}

describe('/v1/responses streaming delivery', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'embersynth-resp-trunc-'));
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

  test('a truncated upstream still delivers response.created and output_item.added', async () => {
    registerAdapter(new TruncatingAdapter());
    const node = makeNode('mock-truncating');
    const res = await handleResponses(makeRequest(), makeConfig(node), makeRegistry(node));
    expect(res.status).toBe(200);
    await settle();
    const { text, failure } = await drain(res);

    expect(text).toContain('event: response.created');
    expect(text).toContain('event: response.output_item.added');
    expect(text).not.toContain('response.completed');
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('truncated');
  });

  test('a complete upstream still ends with response.completed and closes cleanly', async () => {
    registerAdapter(new CompleteAdapter());
    const node = makeNode('mock-complete');
    const res = await handleResponses(makeRequest(), makeConfig(node), makeRegistry(node));
    expect(res.status).toBe(200);
    await settle();
    const { text, failure } = await drain(res);

    expect(failure).toBe(null);
    expect(text).toContain('event: response.created');
    expect(text).toContain('"delta":"Hello"');
    expect(text).toContain('"delta":" world"');
    expect(text).toContain('event: response.output_text.done');
    expect(text).toContain('"text":"Hello world"');
    expect(text).toContain('event: response.completed');
    expect(text.indexOf('event: response.created')).toBeLessThan(text.indexOf('event: response.completed'));
  });

  test('cancelling the body after response.created resolves and ends the stream', async () => {
    registerAdapter(new CompleteAdapter());
    const node = makeNode('mock-complete');
    const res = await handleResponses(makeRequest(), makeConfig(node), makeRegistry(node));
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain('event: response.created');

    await reader.cancel('client gone');
    expect((await reader.read()).done).toBe(true);
  });
});

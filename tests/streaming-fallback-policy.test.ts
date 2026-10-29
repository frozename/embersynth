import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AdapterRequest,
  AdapterResponse,
  ChatCompletionRequest,
  EmberSynthConfig,
  HealthStatus,
  NodeDefinition,
  ProviderAdapter,
} from '../src/types/index.js';
import type { TraceContext } from '../src/tracing/context.js';
import type { TraceEvent } from '../src/tracing/store.js';
import { registerAdapter, resetAdapters } from '../src/adapters/index.js';
import { DEFAULT_POLICY, DEFAULT_PROFILES, SYNTHETIC_MODEL_MAP } from '../src/config/defaults.js';
import { NodeRegistry } from '../src/registry/registry.js';
import { routeStreaming } from '../src/router/index.js';

// #43: with policy.fallbackEnabled false, a stream:true request must not be
// answered by an alternate node, the same as the non-streaming path.

type CallCount = { req: number; stream: number };

/** Streaming adapter. Nodes listed in `failing` throw 'down' from both methods. */
class StreamMock implements ProviderAdapter {
  readonly type = 'policystream';
  private readonly failing: Set<string>;
  private readonly calls = new Map<string, CallCount>();

  constructor(failing: string[]) {
    this.failing = new Set(failing);
  }

  callsFor(nodeId: string): CallCount {
    let entry = this.calls.get(nodeId);
    if (entry === undefined) {
      entry = { req: 0, stream: 0 };
      this.calls.set(nodeId, entry);
    }
    return entry;
  }

  async sendRequest(node: NodeDefinition, _request: AdapterRequest, _signal?: AbortSignal): Promise<AdapterResponse> {
    this.callsFor(node.id).req += 1;
    if (this.failing.has(node.id)) {
      throw new Error('down');
    }
    return { content: `from-${node.id}`, finishReason: 'stop' };
  }

  async *sendStreamingRequest(
    node: NodeDefinition,
    _request: AdapterRequest,
    _signal?: AbortSignal,
  ): AsyncGenerator<string> {
    this.callsFor(node.id).stream += 1;
    if (this.failing.has(node.id)) {
      throw new Error('down');
    }
    yield `from-${node.id}`;
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    return { nodeId: node.id, state: 'healthy', consecutiveFailures: 0 };
  }
}

/** Non-streaming adapter: it has no sendStreamingRequest. */
class BufferedMock implements ProviderAdapter {
  readonly type = 'policybuffered';
  requestCalls = 0;

  async sendRequest(node: NodeDefinition, _request: AdapterRequest, _signal?: AbortSignal): Promise<AdapterResponse> {
    this.requestCalls += 1;
    return { content: `buffered-${node.id}`, finishReason: 'stop' };
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    return { nodeId: node.id, state: 'healthy', consecutiveFailures: 0 };
  }
}

const request: ChatCompletionRequest = {
  model: 'fusion-auto',
  stream: true,
  messages: [{ role: 'user', content: 'hi' }],
};
const STAGE0_MESSAGE = 'Stage 0 (reasoning) failed: no healthy nodes available after fallback';

let tempDir = '';
let previousEvidencePath: string | undefined;

function makeNode(id: string, priority: number, providerType: string): NodeDefinition {
  return {
    id,
    label: `Node ${id}`,
    endpoint: 'http://127.0.0.1:9',
    transport: 'http',
    enabled: true,
    capabilities: ['reasoning'],
    tags: ['local'],
    auth: { type: 'none' },
    health: {},
    timeout: {},
    priority,
    providerType,
  };
}

// reason-a (priority 1) is the planned primary; reason-b (priority 10) is the only alternate.
function setup(
  fallbackEnabled: boolean,
  primaryType: string,
): { registry: NodeRegistry; config: EmberSynthConfig } {
  const nodes = [makeNode('reason-a', 1, primaryType), makeNode('reason-b', 10, 'policystream')];
  const registry = new NodeRegistry();
  registry.load(nodes);
  const config: EmberSynthConfig = {
    server: { host: '127.0.0.1', port: 0 },
    nodes,
    profiles: DEFAULT_PROFILES,
    policy: { ...DEFAULT_POLICY, fallbackEnabled, maxRetries: 0, retryDelayMs: 1 },
    syntheticModels: SYNTHETIC_MODEL_MAP,
  };
  return { registry, config };
}

function makeTrace(phases: TraceEvent['phase'][]): TraceContext {
  return {
    traceId: 'trace-e43dd',
    record(phase: TraceEvent['phase'], _data: Record<string, unknown>): void {
      phases.push(phase);
    },
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe('routeStreaming honours policy.fallbackEnabled (#43)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'embersynth-fallback-policy-'));
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

  test('fallback disabled: a failing primary stream returns 502 and never reaches the alternate', async () => {
    const mock = new StreamMock(['reason-a']);
    registerAdapter(mock);
    const h = setup(false, 'policystream');

    const result = await routeStreaming(request, h.config, h.registry);

    expect(mock.callsFor('reason-b')).toEqual({ req: 0, stream: 0 });
    expect(mock.callsFor('reason-a')).toEqual({ req: 1, stream: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected an ok:false router result');
    }
    expect(result.error.status).toBe(502);
    expect(result.error.message).toBe(STAGE0_MESSAGE);
  });

  test('control: fallback enabled still streams from the alternate when the primary stream fails', async () => {
    const mock = new StreamMock(['reason-a']);
    registerAdapter(mock);
    const h = setup(true, 'policystream');

    const result = await routeStreaming(request, h.config, h.registry);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an ok:true router result');
    }
    const text = await readAll(result.result.stream);
    expect(text).toContain('from-reason-b');
    expect(mock.callsFor('reason-a')).toEqual({ req: 0, stream: 1 });
    expect(mock.callsFor('reason-b')).toEqual({ req: 0, stream: 1 });
  });

  test('fallback disabled: a non-streaming primary answers through the buffered path, not the alternate', async () => {
    const buffered = new BufferedMock();
    const mock = new StreamMock([]);
    registerAdapter(buffered);
    registerAdapter(mock);
    const h = setup(false, 'policybuffered');
    const phases: TraceEvent['phase'][] = [];

    const result = await routeStreaming(request, h.config, h.registry, makeTrace(phases));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an ok:true router result');
    }
    const text = await readAll(result.result.stream);
    expect(text).toContain('buffered-reason-a');
    expect(mock.callsFor('reason-b')).toEqual({ req: 0, stream: 0 });
    expect(buffered.requestCalls).toBe(1);
    // No 'error' phase: the buffered path ran directly, not as the retry after a failed stream.
    expect(phases).toEqual(['classify', 'plan']);
  });

  test('control: fallback enabled still streams from the alternate when the primary cannot stream', async () => {
    const buffered = new BufferedMock();
    const mock = new StreamMock([]);
    registerAdapter(buffered);
    registerAdapter(mock);
    const h = setup(true, 'policybuffered');

    const result = await routeStreaming(request, h.config, h.registry);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an ok:true router result');
    }
    const text = await readAll(result.result.stream);
    expect(text).toContain('from-reason-b');
    expect(mock.callsFor('reason-b')).toEqual({ req: 0, stream: 1 });
    expect(buffered.requestCalls).toBe(0);
  });
});

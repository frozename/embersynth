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
import { routeStreaming, type StreamingRouterResult } from '../src/router/index.js';

/** Non-streaming adapter: no sendStreamingRequest, so routeStreaming takes the executePlan fallback. */
class NoStreamAdapter implements ProviderAdapter {
  readonly type = 'nostream';
  private readonly failMessage: string | null;

  constructor(failMessage: string | null) {
    this.failMessage = failMessage;
  }

  async sendRequest(_node: NodeDefinition, _request: AdapterRequest): Promise<AdapterResponse> {
    if (this.failMessage !== null) {
      throw new Error(this.failMessage);
    }
    return { content: 'hi', finishReason: 'stop' };
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    return { nodeId: node.id, state: 'healthy', consecutiveFailures: 0 };
  }
}

interface RecordedTrace {
  phase: TraceEvent['phase'];
  data: Record<string, unknown>;
}

interface Settled {
  result: StreamingRouterResult | null;
  rejection: string | null;
}

let tempDir = '';
let previousEvidencePath: string | undefined;

function makeNode(): NodeDefinition {
  return {
    id: 'nostream-1',
    label: 'No-stream node',
    endpoint: 'http://127.0.0.1:9',
    transport: 'http',
    enabled: true,
    capabilities: ['reasoning'],
    tags: ['local'],
    auth: { type: 'none' },
    health: {},
    timeout: {},
    priority: 10,
    providerType: 'nostream',
  };
}

function makeConfig(node: NodeDefinition): EmberSynthConfig {
  return {
    server: { host: '127.0.0.1', port: 0 },
    nodes: [node],
    profiles: DEFAULT_PROFILES,
    policy: { ...DEFAULT_POLICY, retryDelayMs: 1 },
    syntheticModels: SYNTHETIC_MODEL_MAP,
  };
}

function makeTrace(events: RecordedTrace[]): TraceContext {
  return {
    traceId: 'trace-e7h',
    record(phase: TraceEvent['phase'], data: Record<string, unknown>): void {
      events.push({ phase, data });
    },
  };
}

const request: ChatCompletionRequest = {
  model: 'fusion-auto',
  stream: true,
  messages: [{ role: 'user', content: 'hi' }],
};

/** Resolves even when routeStreaming rejects, so a rejection is an assertion failure, not a crash. */
async function settleRoute(adapter: NoStreamAdapter, events: RecordedTrace[]): Promise<Settled> {
  registerAdapter(adapter);
  const node = makeNode();
  const registry = new NodeRegistry();
  registry.load([node]);
  try {
    const result = await routeStreaming(request, makeConfig(node), registry, makeTrace(events));
    return { result, rejection: null };
  } catch (err) {
    return { result: null, rejection: err instanceof Error ? err.message : String(err) };
  }
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

describe('routeStreaming non-streaming fallback (#7)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'embersynth-nostream-'));
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

  test('a failed fallback resolves to a 502 with the stage message and records a trace error', async () => {
    const events: RecordedTrace[] = [];
    const { result, rejection } = await settleRoute(new NoStreamAdapter('boom'), events);

    expect(rejection).toBeNull();
    if (result === null || result.ok) {
      throw new Error('expected an ok:false router result');
    }
    expect(result.error.status).toBe(502);
    expect(result.error.message).toContain('failed: no healthy nodes available after fallback');
    const errorEvents = events.filter((e) => e.phase === 'error');
    expect(errorEvents.length).toBe(1);
    expect(String(errorEvents[0].data.message)).toContain('failed: no healthy nodes available after fallback');
  });

  test('a successful fallback still returns the single-chunk SSE stream', async () => {
    const events: RecordedTrace[] = [];
    const { result, rejection } = await settleRoute(new NoStreamAdapter(null), events);

    expect(rejection).toBeNull();
    if (result === null || !result.ok) {
      throw new Error('expected an ok:true router result');
    }
    const text = await readAll(result.result.stream);
    expect(text).toContain('"content":"hi"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(events.some((e) => e.phase === 'error')).toBe(false);
  });
});

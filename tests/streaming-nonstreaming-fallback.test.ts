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
import type { ToolCall } from '../src/types/tools.js';
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
  private readonly response: AdapterResponse;

  constructor(failMessage: string | null, response?: AdapterResponse) {
    this.failMessage = failMessage;
    this.response = response ?? { content: 'hi', finishReason: 'stop' };
  }

  async sendRequest(_node: NodeDefinition, _request: AdapterRequest): Promise<AdapterResponse> {
    if (this.failMessage !== null) {
      throw new Error(this.failMessage);
    }
    return this.response;
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

const weatherCall: ToolCall = {
  id: 'call_1',
  type: 'function',
  function: { name: 'get_weather', arguments: '{"city":"Lisbon"}' },
};

/** Runs the fallback with a fake adapter returning `response` and returns the whole SSE body. */
async function fallbackText(response: AdapterResponse): Promise<string> {
  const events: RecordedTrace[] = [];
  const { result, rejection } = await settleRoute(new NoStreamAdapter(null, response), events);
  expect(rejection).toBeNull();
  if (result === null || !result.ok) {
    throw new Error('expected an ok:true router result');
  }
  return readAll(result.result.stream);
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

  test('the fallback passes through finish_reason length (#11)', async () => {
    const text = await fallbackText({ content: 'partial', finishReason: 'length' });

    expect(text).toContain('"content":"partial"');
    expect(text).toContain('"finish_reason":"length"');
    expect(text).not.toContain('"finish_reason":"stop"');
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  test('the fallback passes through finish_reason content_filter (#11)', async () => {
    const text = await fallbackText({ content: 'filtered', finishReason: 'content_filter' });

    expect(text).toContain('"finish_reason":"content_filter"');
    expect(text).not.toContain('"finish_reason":"stop"');
  });

  test('an empty toolCalls array reports stop and no tool_calls (#11)', async () => {
    const text = await fallbackText({ content: 'x', finishReason: 'stop', toolCalls: [] });

    expect(text).toContain('"finish_reason":"stop"');
    expect(text).not.toContain('tool_calls');
  });

  test('a tool call with finish_reason tool_calls emits the tool_calls delta (#11)', async () => {
    const text = await fallbackText({ content: '', finishReason: 'tool_calls', toolCalls: [weatherCall] });

    expect(text).toContain('"tool_calls":[{"index":0,"id":"call_1","type":"function"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).not.toContain('"finish_reason":"stop"');
  });

  test('a tool call with finish_reason stop still ends with tool_calls (#11)', async () => {
    const text = await fallbackText({ content: '', finishReason: 'stop', toolCalls: [weatherCall] });

    expect(text).toContain('"tool_calls":[{"index":0,"id":"call_1"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).not.toContain('"finish_reason":"stop"');
  });

  test('an empty finishReason without tool calls ends with stop (#11)', async () => {
    const text = await fallbackText({ content: 'x', finishReason: '' });

    expect(text).toContain('"finish_reason":"stop"');
    expect(text).not.toContain('tool_calls');
  });
});

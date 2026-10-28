import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AdapterRequest,
  AdapterResponse,
  Capability,
  ChatCompletionRequest,
  ChatMessage,
  EmberSynthConfig,
  HealthStatus,
  NodeDefinition,
  ProviderAdapter,
  RoutingPolicy,
} from '../src/types/index.js';
import type { TraceContext } from '../src/tracing/context.js';
import type { TraceEvent } from '../src/tracing/store.js';
import { registerAdapter, resetAdapters } from '../src/adapters/index.js';
import { DEFAULT_POLICY, DEFAULT_PROFILES, SYNTHETIC_MODEL_MAP } from '../src/config/defaults.js';
import { NodeRegistry } from '../src/registry/registry.js';
import { classifyRequest } from '../src/router/classifier.js';
import { buildPlan } from '../src/router/planner.js';
import { executePlanStreaming, StageExecutionError } from '../src/router/executor.js';
import { routeStreaming } from '../src/router/index.js';

/** Vision-stage adapter: sendRequest fails with 'vision down' when built with fail = true. */
class VisionMock implements ProviderAdapter {
  readonly type = 'visionmock';
  calls = 0;
  private readonly fail: boolean;

  constructor(fail: boolean) {
    this.fail = fail;
  }

  async sendRequest(_node: NodeDefinition, _request: AdapterRequest, _signal?: AbortSignal): Promise<AdapterResponse> {
    this.calls += 1;
    if (this.fail) {
      throw new Error('vision down');
    }
    return { content: 'a red square', finishReason: 'stop' };
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    return { nodeId: node.id, state: 'healthy', consecutiveFailures: 0 };
  }
}

/** Reasoning-stage adapter that counts non-streaming and streaming calls separately. */
class ReasonMock implements ProviderAdapter {
  readonly type = 'reasonmock';
  requestCalls = 0;
  streamCalls = 0;
  private readonly streamError: string | null;
  private readonly abortOnStream: AbortController | null;

  constructor(streamError: string | null, abortOnStream: AbortController | null) {
    this.streamError = streamError;
    this.abortOnStream = abortOnStream;
  }

  async sendRequest(_node: NodeDefinition, _request: AdapterRequest, _signal?: AbortSignal): Promise<AdapterResponse> {
    this.requestCalls += 1;
    return { content: 'answer', finishReason: 'stop' };
  }

  async *sendStreamingRequest(
    _node: NodeDefinition,
    _request: AdapterRequest,
    _signal?: AbortSignal,
  ): AsyncGenerator<string> {
    this.streamCalls += 1;
    if (this.abortOnStream !== null) {
      this.abortOnStream.abort();
    }
    if (this.streamError !== null) {
      throw new Error(this.streamError);
    }
    yield 'answer';
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    return { nodeId: node.id, state: 'healthy', consecutiveFailures: 0 };
  }
}

interface RecordedTrace {
  phase: TraceEvent['phase'];
  data: Record<string, unknown>;
}

interface Harness {
  vision: VisionMock;
  reason: ReasonMock;
  registry: NodeRegistry;
  config: EmberSynthConfig;
}

const STAGE0_MESSAGE = 'Stage 0 (vision) failed: no healthy nodes available after fallback';
const policy: RoutingPolicy = { ...DEFAULT_POLICY, maxRetries: 0, retryDelayMs: 1 };
const messages: ChatMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
    ],
  },
];
const request: ChatCompletionRequest = { model: 'fusion-auto', stream: true, messages };

let tempDir = '';
let previousEvidencePath: string | undefined;

function makeNode(id: string, capability: Capability, providerType: string): NodeDefinition {
  return {
    id,
    label: `Node ${id}`,
    endpoint: 'http://127.0.0.1:9',
    transport: 'http',
    enabled: true,
    capabilities: [capability],
    tags: ['local'],
    auth: { type: 'none' },
    health: {},
    timeout: {},
    priority: 10,
    providerType,
  };
}

function setup(vision: VisionMock, reason: ReasonMock): Harness {
  registerAdapter(vision);
  registerAdapter(reason);
  const nodes = [makeNode('vision-1', 'vision', 'visionmock'), makeNode('reason-1', 'reasoning', 'reasonmock')];
  const registry = new NodeRegistry();
  registry.load(nodes);
  const config: EmberSynthConfig = {
    server: { host: '127.0.0.1', port: 0 },
    nodes,
    profiles: DEFAULT_PROFILES,
    policy,
    syntheticModels: SYNTHETIC_MODEL_MAP,
  };
  return { vision, reason, registry, config };
}

function makeTrace(events: RecordedTrace[]): TraceContext {
  return {
    traceId: 'trace-e12na',
    record(phase: TraceEvent['phase'], data: Record<string, unknown>): void {
      events.push({ phase, data });
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

describe('routeStreaming intermediate-stage failure (#12)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'embersynth-intermediate-'));
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

  test('a failed intermediate stage returns 502 without running the final stage', async () => {
    const h = setup(new VisionMock(true), new ReasonMock(null, null));
    const events: RecordedTrace[] = [];

    const result = await routeStreaming(request, h.config, h.registry, makeTrace(events));

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected an ok:false router result');
    }
    expect(result.error.status).toBe(502);
    expect(result.error.message).toBe(STAGE0_MESSAGE);
    expect(h.vision.calls).toBe(1);
    expect(h.reason.requestCalls).toBe(0);
    expect(h.reason.streamCalls).toBe(0);
    const errorEvents = events.filter((e) => e.phase === 'error');
    expect(errorEvents.length).toBe(1);
    expect(String(errorEvents[0].data.message)).toBe(STAGE0_MESSAGE);
  });

  test('control: a final-stage stream failure still takes the final-only non-streaming retry', async () => {
    const h = setup(new VisionMock(false), new ReasonMock('stream refused', null));
    const events: RecordedTrace[] = [];

    const result = await routeStreaming(request, h.config, h.registry, makeTrace(events));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an ok:true router result');
    }
    const text = await readAll(result.result.stream);
    expect(text).toContain('"content":"answer"');
    expect(h.vision.calls).toBe(1);
    expect(h.reason.streamCalls).toBe(1);
    expect(h.reason.requestCalls).toBe(1);
    expect(events.filter((e) => e.phase === 'error').length).toBe(1);
  });

  test('a caller cancel while the final stream opens returns 502 without the non-streaming retry', async () => {
    const controller = new AbortController();
    const h = setup(new VisionMock(false), new ReasonMock('stream cancelled', controller));

    const result = await routeStreaming(request, h.config, h.registry, undefined, controller.signal);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected an ok:false router result');
    }
    expect(result.error.status).toBe(502);
    expect(result.error.message).toBe('stream cancelled');
    expect(controller.signal.aborted).toBe(true);
    expect(h.vision.calls).toBe(1);
    expect(h.reason.streamCalls).toBe(1);
    expect(h.reason.requestCalls).toBe(0);
  });

  test('executePlanStreaming throws StageExecutionError with the unchanged message', async () => {
    const h = setup(new VisionMock(true), new ReasonMock(null, null));
    const autoProfile = DEFAULT_PROFILES.find((p) => p.id === 'auto');
    if (autoProfile === undefined) {
      throw new Error('auto profile missing');
    }
    const planResult = buildPlan(classifyRequest(messages), autoProfile, policy, h.registry);
    if (!planResult.ok) {
      throw new Error(`plan failed: ${planResult.error.message}`);
    }
    expect(planResult.plan.stages.map((s) => s.capability)).toEqual(['vision', 'reasoning']);

    let caught: unknown = null;
    try {
      await executePlanStreaming(planResult.plan, messages, h.registry, policy, autoProfile, 'fusion-auto');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StageExecutionError);
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof StageExecutionError)) {
      throw new Error('expected a StageExecutionError');
    }
    expect(caught.stageIndex).toBe(0);
    expect(caught.name).toBe('StageExecutionError');
    expect(caught.message).toBe(STAGE0_MESSAGE);
    expect(h.reason.streamCalls).toBe(0);
  });
});

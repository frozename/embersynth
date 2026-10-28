import { describe, test, expect, afterEach } from 'bun:test';
import type {
  AdapterRequest,
  AdapterResponse,
  ChatMessage,
  EmberSynthConfig,
  EmbeddingAdapterRequest,
  EmbeddingAdapterResponse,
  EmbeddingRequest,
  ExecutionPlan,
  HealthStatus,
  NodeDefinition,
  ProviderAdapter,
  RoutingPolicy,
} from '../src/types/index.js';
import { registerAdapter, resetAdapters } from '../src/adapters/index.js';
import { DEFAULT_CONFIG, DEFAULT_POLICY, DEFAULT_PROFILES } from '../src/config/defaults.js';
import { NodeRegistry } from '../src/registry/registry.js';
import { classifyRequest } from '../src/router/classifier.js';
import { buildPlan } from '../src/router/planner.js';
import { executePlan, executePlanStreaming } from '../src/router/executor.js';
import { routeEmbedding } from '../src/router/index.js';

/** Counts calls and always fails with the error that `makeError` builds. */
class AbortProbeAdapter implements ProviderAdapter {
  readonly type = 'abort-probe';
  calls = 0;
  private readonly makeError: () => Error;

  constructor(makeError: () => Error) {
    this.makeError = makeError;
  }

  async sendRequest(_node: NodeDefinition, _request: AdapterRequest, _signal?: AbortSignal): Promise<AdapterResponse> {
    this.calls += 1;
    throw this.makeError();
  }

  async *sendStreamingRequest(
    _node: NodeDefinition,
    _request: AdapterRequest,
    _signal?: AbortSignal,
  ): AsyncGenerator<string> {
    this.calls += 1;
    throw this.makeError();
  }

  async sendEmbeddingRequest(
    _node: NodeDefinition,
    _request: EmbeddingAdapterRequest,
    _signal?: AbortSignal,
  ): Promise<EmbeddingAdapterResponse> {
    this.calls += 1;
    throw this.makeError();
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    return { nodeId: node.id, state: 'healthy', consecutiveFailures: 0 };
  }
}

/** Same shape as the error fetch throws on an aborted signal. */
function abortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function makeNode(id: string, priority: number): NodeDefinition {
  return {
    id,
    label: `Abort probe ${id}`,
    endpoint: 'http://localhost:8080',
    transport: 'http',
    enabled: true,
    capabilities: ['reasoning', 'embedding'],
    tags: ['local', 'private'],
    auth: { type: 'none' },
    health: { endpoint: '/health', intervalMs: 30000, timeoutMs: 5000, unhealthyAfter: 3 },
    timeout: { requestMs: 120000, connectMs: 5000 },
    priority,
    providerType: 'abort-probe',
  };
}

const autoProfile = DEFAULT_PROFILES.find((p) => p.id === 'auto')!;
const policy: RoutingPolicy = { ...DEFAULT_POLICY, retryDelayMs: 1 };
const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

interface Harness {
  adapter: AbortProbeAdapter;
  registry: NodeRegistry;
  nodes: NodeDefinition[];
}

function setup(makeError: () => Error): Harness {
  const adapter = new AbortProbeAdapter(makeError);
  registerAdapter(adapter);
  const nodes = [makeNode('A', 1), makeNode('B', 2)];
  const registry = new NodeRegistry();
  registry.load(nodes);
  return { adapter, registry, nodes };
}

function planFor(registry: NodeRegistry): ExecutionPlan {
  const planResult = buildPlan(classifyRequest(messages), autoProfile, policy, registry);
  if (!planResult.ok) {
    throw new Error(`plan failed: ${planResult.error.message}`);
  }
  return planResult.plan;
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject');
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : String(err);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

describe('caller abort does not count against node health (#8)', () => {
  afterEach(() => {
    resetAdapters();
  });

  test('executePlan: a caller abort rejects after one call and leaves both nodes unknown', async () => {
    const { adapter, registry } = setup(() => abortError('aborted'));
    const plan = planFor(registry);
    expect(plan.stages[0].nodeId).toBe('A');

    const err = await rejectionOf(
      executePlan(plan, messages, registry, policy, autoProfile, undefined, abortedSignal()),
    );

    expect(adapter.calls).toBe(1);
    expect(registry.getHealth('A')?.state).toBe('unknown');
    expect(registry.getHealth('B')?.state).toBe('unknown');
    expect(errorName(err)).toBe('AbortError');
  });

  test('executePlanStreaming: a caller abort rejects after one call and leaves both nodes unknown', async () => {
    const { adapter, registry } = setup(() => abortError('aborted'));
    const plan = planFor(registry);

    const err = await rejectionOf(
      executePlanStreaming(plan, messages, registry, policy, autoProfile, 'fusion-auto', undefined, abortedSignal()),
    );

    expect(adapter.calls).toBe(1);
    expect(registry.getHealth('A')?.state).toBe('unknown');
    expect(registry.getHealth('B')?.state).toBe('unknown');
    expect(errorName(err)).toBe('AbortError');
  });

  test('routeEmbedding: a caller abort returns not-ok after one call and leaves both nodes unknown', async () => {
    const { adapter, registry, nodes } = setup(() => abortError('aborted'));
    const config: EmberSynthConfig = { ...DEFAULT_CONFIG, nodes, policy };
    const request: EmbeddingRequest = { model: 'fusion-auto', input: ['hello'] };

    const result = await routeEmbedding(request, config, registry, undefined, abortedSignal());

    expect(adapter.calls).toBe(1);
    expect(registry.getHealth('A')?.state).toBe('unknown');
    expect(registry.getHealth('B')?.state).toBe('unknown');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.message).toContain('cancelled by the caller');
  });

  test('control: a plain upstream error with a live signal still marks the nodes unhealthy', async () => {
    const { adapter, registry } = setup(() => new Error('upstream exploded'));
    const plan = planFor(registry);

    await rejectionOf(
      executePlan(plan, messages, registry, policy, autoProfile, undefined, new AbortController().signal),
    );

    expect(adapter.calls).toBe(6);
    expect(registry.getHealth('A')?.state).toBe('unhealthy');
    expect(registry.getHealth('A')?.consecutiveFailures).toBe(3);
    expect(registry.getHealth('B')?.state).toBe('unhealthy');
  });

  test('control: an AbortError from a per-node timeout with a live caller signal still counts', async () => {
    const { adapter, registry } = setup(() => abortError('node timeout'));
    const plan = planFor(registry);

    await rejectionOf(
      executePlan(plan, messages, registry, policy, autoProfile, undefined, new AbortController().signal),
    );

    expect(adapter.calls).toBe(6);
    expect(registry.getHealth('A')?.state).toBe('unhealthy');
    expect(registry.getHealth('A')?.error).toBe('node timeout');
  });

  test('control: a streaming candidate failure with a live signal still degrades both nodes', async () => {
    const { adapter, registry } = setup(() => new Error('upstream exploded'));
    const plan = planFor(registry);

    const err = await rejectionOf(
      executePlanStreaming(
        plan,
        messages,
        registry,
        policy,
        autoProfile,
        'fusion-auto',
        undefined,
        new AbortController().signal,
      ),
    );

    expect(adapter.calls).toBe(2);
    expect(registry.getHealth('A')?.state).toBe('degraded');
    expect(registry.getHealth('B')?.state).toBe('degraded');
    expect(errorMessage(err)).toContain('No streaming-capable node');
  });
});

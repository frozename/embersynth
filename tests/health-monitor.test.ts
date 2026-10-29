import { describe, test, expect, afterEach } from 'bun:test';
import type {
  AdapterRequest,
  AdapterResponse,
  HealthStatus,
  NodeDefinition,
  ProviderAdapter,
} from '../src/types/index.js';
import { registerAdapter, resetAdapters } from '../src/adapters/index.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { NodeRegistry } from '../src/registry/registry.js';
import { HealthMonitor } from '../src/health/monitor.js';

// Pins HealthMonitor.checkNode / checkAll (src/health/monitor.ts) with a fake adapter.
// start() is never called, so no interval timer is armed; nothing waits on a clock.

type HealthReply = (node: NodeDefinition) => Promise<HealthStatus>;

/** Records every checkHealth call by node id and answers with `reply`. */
class MonitorProbeAdapter implements ProviderAdapter {
  readonly type = 'pin-monitor';
  readonly calls: string[] = [];
  private readonly reply: HealthReply;

  constructor(reply: HealthReply) {
    this.reply = reply;
  }

  async sendRequest(_node: NodeDefinition, _request: AdapterRequest, _signal?: AbortSignal): Promise<AdapterResponse> {
    throw new Error('HealthMonitor never sends requests');
  }

  async checkHealth(node: NodeDefinition, _signal?: AbortSignal): Promise<HealthStatus> {
    this.calls.push(node.id);
    return this.reply(node);
  }
}

function makeNode(overrides: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: 'test-node',
    label: 'Test Node',
    endpoint: 'http://localhost:8080',
    transport: 'http',
    enabled: true,
    capabilities: ['reasoning'],
    tags: ['local', 'private'],
    auth: { type: 'none' },
    health: { endpoint: '/health', intervalMs: 30000, timeoutMs: 5000, unhealthyAfter: 3 },
    timeout: { requestMs: 120000, connectMs: 5000 },
    priority: 10,
    providerType: 'pin-monitor',
    ...overrides,
  };
}

function unhealthyAfter(threshold: number): NodeDefinition['health'] {
  return { endpoint: '/health', intervalMs: 30000, timeoutMs: 5000, unhealthyAfter: threshold };
}

function replyWith(status: Omit<HealthStatus, 'nodeId'>): HealthReply {
  return async (node: NodeDefinition): Promise<HealthStatus> => ({ nodeId: node.id, ...status });
}

function replyRejecting(reason: unknown): HealthReply {
  return async (): Promise<HealthStatus> => {
    throw reason;
  };
}

interface Gate {
  promise: Promise<HealthStatus>;
  open: (status: HealthStatus) => void;
}

/** A promise the test settles by hand, so the in-flight window is explicit. */
function gate(): Gate {
  let open: (status: HealthStatus) => void = () => {};
  const promise = new Promise<HealthStatus>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

interface Harness {
  adapter: MonitorProbeAdapter;
  registry: NodeRegistry;
  monitor: HealthMonitor;
}

function setup(reply: HealthReply, nodes: NodeDefinition[]): Harness {
  const adapter = new MonitorProbeAdapter(reply);
  registerAdapter(adapter);
  const registry = new NodeRegistry();
  registry.load(nodes);
  const monitor = new HealthMonitor({ ...DEFAULT_CONFIG, nodes }, registry);
  return { adapter, registry, monitor };
}

describe('HealthMonitor.checkNode', () => {
  afterEach(() => {
    resetAdapters();
  });

  test('records a healthy reply with its latency and zero failures', async () => {
    const { adapter, registry, monitor } = setup(
      replyWith({ state: 'healthy', latencyMs: 7, consecutiveFailures: 0 }),
      [makeNode({ id: 'a' })],
    );

    await monitor.checkNode('a');

    expect(adapter.calls).toEqual(['a']);
    const health = registry.getHealth('a');
    expect(health?.state).toBe('healthy');
    expect(health?.latencyMs).toBe(7);
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.error).toBeUndefined();
  });

  test('passes the reply state and error through to the registry', async () => {
    const { registry, monitor } = setup(
      replyWith({ state: 'unhealthy', latencyMs: 4, error: 'HTTP 503', consecutiveFailures: 0 }),
      [makeNode({ id: 'a', health: unhealthyAfter(1) })],
    );

    await monitor.checkNode('a');

    const health = registry.getHealth('a');
    expect(health?.state).toBe('unhealthy');
    expect(health?.latencyMs).toBe(4);
    expect(health?.error).toBe('HTTP 503');
    expect(health?.consecutiveFailures).toBe(1);
  });

  test('a second check while one is in flight does not call the adapter again', async () => {
    const pending = gate();
    const { adapter, registry, monitor } = setup(() => pending.promise, [makeNode({ id: 'a' })]);

    const first = monitor.checkNode('a');
    const second = monitor.checkNode('a');

    expect(adapter.calls).toEqual(['a']);
    pending.open({ nodeId: 'a', state: 'healthy', latencyMs: 3, consecutiveFailures: 0 });
    await Promise.all([first, second]);
    expect(registry.getHealth('a')?.state).toBe('healthy');

    await monitor.checkNode('a');
    expect(adapter.calls).toEqual(['a', 'a']);
  });

  test('an adapter rejection marks the node unhealthy with the error message and does not reject', async () => {
    const { adapter, registry, monitor } = setup(replyRejecting(new Error('boom')), [
      makeNode({ id: 'a', health: unhealthyAfter(1) }),
    ]);

    await expect(monitor.checkNode('a')).resolves.toBeUndefined();

    const health = registry.getHealth('a');
    expect(health?.state).toBe('unhealthy');
    expect(health?.error).toBe('boom');
    expect(health?.latencyMs).toBeUndefined();
    expect(health?.consecutiveFailures).toBe(1);

    await monitor.checkNode('a');
    expect(adapter.calls).toEqual(['a', 'a']);
    expect(registry.getHealth('a')?.consecutiveFailures).toBe(2);
  });

  test('a non-Error rejection is stored as its string form', async () => {
    const { registry, monitor } = setup(replyRejecting('plain'), [makeNode({ id: 'a' })]);

    await monitor.checkNode('a');

    expect(registry.getHealth('a')?.error).toBe('plain');
  });

  test('rejections stay degraded until unhealthyAfter consecutive failures', async () => {
    const { registry, monitor } = setup(replyRejecting(new Error('boom')), [
      makeNode({ id: 'a', health: unhealthyAfter(3) }),
    ]);

    await monitor.checkNode('a');
    expect(registry.getHealth('a')?.state).toBe('degraded');
    expect(registry.getHealth('a')?.consecutiveFailures).toBe(1);

    await monitor.checkNode('a');
    expect(registry.getHealth('a')?.state).toBe('degraded');

    await monitor.checkNode('a');
    expect(registry.getHealth('a')?.state).toBe('unhealthy');
    expect(registry.getHealth('a')?.consecutiveFailures).toBe(3);
  });

  test('a disabled node and an unknown id are skipped without an adapter call', async () => {
    const { adapter, registry, monitor } = setup(
      replyWith({ state: 'healthy', latencyMs: 1, consecutiveFailures: 0 }),
      [makeNode({ id: 'off', enabled: false })],
    );

    await monitor.checkNode('off');
    await monitor.checkNode('missing');

    expect(adapter.calls).toEqual([]);
    expect(registry.getHealth('off')).toEqual({ nodeId: 'off', state: 'unknown', consecutiveFailures: 0 });
    expect(registry.getHealth('missing')).toBeUndefined();
  });

  test('a node whose providerType has no registered adapter is skipped', async () => {
    const { adapter, registry, monitor } = setup(
      replyWith({ state: 'healthy', latencyMs: 1, consecutiveFailures: 0 }),
      [makeNode({ id: 'orphan', providerType: 'pin-monitor-unregistered' })],
    );

    await expect(monitor.checkNode('orphan')).resolves.toBeUndefined();

    expect(adapter.calls).toEqual([]);
    expect(registry.getHealth('orphan')?.state).toBe('unknown');
  });
});

describe('HealthMonitor.checkAll', () => {
  afterEach(() => {
    resetAdapters();
  });

  test('checks each enabled node once and resolves when one adapter call rejects', async () => {
    const reply: HealthReply = async (node: NodeDefinition): Promise<HealthStatus> => {
      if (node.id === 'b') throw new Error('b is down');
      return { nodeId: node.id, state: 'healthy', latencyMs: 2, consecutiveFailures: 0 };
    };
    const { adapter, registry, monitor } = setup(reply, [
      makeNode({ id: 'a' }),
      makeNode({ id: 'b' }),
      makeNode({ id: 'off', enabled: false }),
    ]);

    await expect(monitor.checkAll()).resolves.toBeUndefined();

    expect(adapter.calls).toEqual(['a', 'b']);
    expect(registry.getHealth('a')?.state).toBe('healthy');
    expect(registry.getHealth('b')?.state).toBe('degraded');
    expect(registry.getHealth('b')?.error).toBe('b is down');
    expect(registry.getHealth('off')?.state).toBe('unknown');
  });
});

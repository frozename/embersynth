import { describe, test, expect, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { NodeRegistry } from '../src/registry/registry.js';
import type { NodeDefinition } from '../src/types/index.js';

// Pins the NodeRegistry behaviour that src/config/reload.ts relies on: load() keeps the
// health of surviving nodes and prunes removed ones, snapshotHealth()/restoreHealth()
// roll back a failed swap, updateHealth() carries lastSuccess, plus findByAnyCapability.
// Every timestamp comes from setSystemTime, so no assertion depends on the real clock.

const T1 = 1_700_000_000_000;
const T2 = 1_700_000_005_000;
const T3 = 1_700_000_010_000;

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
    providerType: 'openai-compatible',
    ...overrides,
  };
}

function ids(items: { id: string }[]): string[] {
  return items.map((n) => n.id);
}

describe('NodeRegistry reload and health carry-over', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
    setSystemTime(T1);
  });

  afterEach(() => {
    setSystemTime();
  });

  test('a second load keeps surviving health, adds unknown for new ids and prunes removed ids', () => {
    registry.load([makeNode({ id: 'a' }), makeNode({ id: 'b', health: { unhealthyAfter: 1 } })]);
    registry.updateHealth('a', 'healthy', 12);
    registry.updateHealth('b', 'unhealthy', undefined, 'refused');

    setSystemTime(T2);
    registry.load([makeNode({ id: 'a' }), makeNode({ id: 'c' })]);

    expect(registry.getHealth('a')).toEqual({
      nodeId: 'a',
      state: 'healthy',
      lastCheck: T1,
      lastSuccess: T1,
      consecutiveFailures: 0,
      latencyMs: 12,
      error: undefined,
    });
    expect(registry.getHealth('c')).toEqual({ nodeId: 'c', state: 'unknown', consecutiveFailures: 0 });
    expect(registry.getHealth('b')).toBeUndefined();
    expect(registry.getAllHealth().map((h) => h.nodeId)).toEqual(['a', 'c']);
  });

  test('load replaces the node set and the definitions of surviving ids', () => {
    registry.load([makeNode({ id: 'a', priority: 10 }), makeNode({ id: 'b' })]);

    const nextA = makeNode({ id: 'a', priority: 2 });
    const nextC = makeNode({ id: 'c' });
    registry.load([nextA, nextC]);

    expect(ids(registry.getAll())).toEqual(['a', 'c']);
    expect(registry.getById('b')).toBeUndefined();
    expect(registry.getById('a')).toBe(nextA);
    expect(registry.getById('c')).toBe(nextC);
    expect(registry.getById('a')?.priority).toBe(2);
  });

  test('snapshotHealth returns a copy that later updates do not change', () => {
    registry.load([makeNode({ id: 'a', health: { unhealthyAfter: 1 } })]);
    registry.updateHealth('a', 'unhealthy', undefined, 'down');

    const snapshot = registry.snapshotHealth();

    setSystemTime(T2);
    registry.updateHealth('a', 'healthy', 9);

    expect(registry.getHealth('a')?.state).toBe('healthy');
    expect(snapshot.get('a')).toEqual({
      nodeId: 'a',
      state: 'unhealthy',
      lastCheck: T1,
      lastSuccess: undefined,
      consecutiveFailures: 1,
      latencyMs: undefined,
      error: 'down',
    });

    registry.restoreHealth(snapshot);

    const restored = registry.getHealth('a');
    expect(restored?.state).toBe('unhealthy');
    expect(restored?.consecutiveFailures).toBe(1);
    expect(restored?.error).toBe('down');
    expect(restored?.lastCheck).toBe(T1);
  });

  test('a failed swap rolled back like reload.ts restores the pruned and the updated health', () => {
    const oldNodes = [makeNode({ id: 'a', health: { unhealthyAfter: 1 } }), makeNode({ id: 'b' })];
    registry.load(oldNodes);
    registry.updateHealth('a', 'unhealthy', undefined, 'down');
    registry.updateHealth('b', 'healthy', 5);

    const snapshot = registry.snapshotHealth();
    registry.load([makeNode({ id: 'a' }), makeNode({ id: 'c' })]);
    setSystemTime(T2);
    registry.updateHealth('a', 'healthy', 1);
    expect(registry.getHealth('b')).toBeUndefined();

    registry.load(oldNodes);
    registry.restoreHealth(snapshot);

    expect(ids(registry.getAll())).toEqual(['a', 'b']);
    expect(registry.getAllHealth().map((h) => h.nodeId)).toEqual(['a', 'b']);
    expect(registry.getHealth('a')?.state).toBe('unhealthy');
    expect(registry.getHealth('a')?.error).toBe('down');
    expect(registry.getHealth('b')?.state).toBe('healthy');
    expect(registry.getHealth('b')?.latencyMs).toBe(5);
    expect(registry.getHealth('c')).toBeUndefined();
  });
});

describe('NodeRegistry.updateHealth carry-over and thresholds', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
    setSystemTime(T1);
  });

  afterEach(() => {
    setSystemTime();
  });

  test('a failed check keeps the previous lastSuccess and moves lastCheck', () => {
    registry.load([makeNode({ id: 'a' })]);
    registry.updateHealth('a', 'healthy', 10);

    setSystemTime(T2);
    registry.updateHealth('a', 'unhealthy', undefined, 'timeout');

    const failed = registry.getHealth('a');
    expect(failed?.lastSuccess).toBe(T1);
    expect(failed?.lastCheck).toBe(T2);
    expect(failed?.consecutiveFailures).toBe(1);
    expect(failed?.state).toBe('degraded');
    expect(failed?.latencyMs).toBeUndefined();
    expect(failed?.error).toBe('timeout');

    setSystemTime(T3);
    registry.updateHealth('a', 'healthy', 8);

    const recovered = registry.getHealth('a');
    expect(recovered?.lastSuccess).toBe(T3);
    expect(recovered?.lastCheck).toBe(T3);
    expect(recovered?.error).toBeUndefined();
  });

  test('without health.unhealthyAfter the threshold defaults to 3', () => {
    registry.load([makeNode({ id: 'a', health: {} })]);

    registry.updateHealth('a', 'unhealthy', undefined, 'err');
    expect(registry.getHealth('a')?.state).toBe('degraded');
    registry.updateHealth('a', 'unhealthy', undefined, 'err');
    expect(registry.getHealth('a')?.state).toBe('degraded');
    registry.updateHealth('a', 'unhealthy', undefined, 'err');
    expect(registry.getHealth('a')?.state).toBe('unhealthy');
    expect(registry.getHealth('a')?.consecutiveFailures).toBe(3);
  });

  test('an id that was never loaded uses the default threshold of 3', () => {
    registry.updateHealth('ghost', 'unhealthy');
    expect(registry.getHealth('ghost')?.state).toBe('degraded');
    registry.updateHealth('ghost', 'unhealthy');
    expect(registry.getHealth('ghost')?.state).toBe('degraded');
    registry.updateHealth('ghost', 'unhealthy');
    expect(registry.getHealth('ghost')?.state).toBe('unhealthy');
    expect(registry.getById('ghost')).toBeUndefined();
  });

  test('a degraded report never escalates but still counts failures', () => {
    registry.load([makeNode({ id: 'a', health: { unhealthyAfter: 1 } })]);

    registry.updateHealth('a', 'degraded');
    registry.updateHealth('a', 'degraded');
    registry.updateHealth('a', 'degraded');

    expect(registry.getHealth('a')?.state).toBe('degraded');
    expect(registry.getHealth('a')?.consecutiveFailures).toBe(3);
  });
});

describe('NodeRegistry.findByAnyCapability', () => {
  test('returns enabled nodes with at least one listed capability, unlike findByCapabilities', () => {
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'r', capabilities: ['reasoning'] }),
      makeNode({ id: 'v', capabilities: ['vision'] }),
      makeNode({ id: 'e', capabilities: ['embedding'] }),
      makeNode({ id: 've', capabilities: ['vision', 'embedding'] }),
      makeNode({ id: 'off', capabilities: ['vision', 'embedding'], enabled: false }),
    ]);

    expect(ids(registry.findByAnyCapability(['vision', 'embedding']))).toEqual(['v', 'e', 've']);
    expect(ids(registry.findByCapabilities(['vision', 'embedding']))).toEqual(['ve']);
    expect(registry.findByAnyCapability([])).toEqual([]);
  });
});

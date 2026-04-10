import { describe, test, expect, beforeEach } from 'bun:test';
import { NodeRegistry } from '../src/registry/registry.js';
import type { NodeDefinition } from '../src/types/index.js';

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

describe('NodeRegistry', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
  });

  test('loads and retrieves nodes', () => {
    const nodes = [makeNode({ id: 'a' }), makeNode({ id: 'b' })];
    registry.load(nodes);
    expect(registry.getAll().length).toBe(2);
    expect(registry.getById('a')).toBeDefined();
    expect(registry.getById('b')).toBeDefined();
  });

  test('getEnabled filters disabled nodes', () => {
    registry.load([
      makeNode({ id: 'enabled', enabled: true }),
      makeNode({ id: 'disabled', enabled: false }),
    ]);
    const enabled = registry.getEnabled();
    expect(enabled.length).toBe(1);
    expect(enabled[0].id).toBe('enabled');
  });

  test('findByCapabilities finds matching nodes', () => {
    registry.load([
      makeNode({ id: 'reasoning', capabilities: ['reasoning'] }),
      makeNode({ id: 'vision', capabilities: ['vision'] }),
      makeNode({ id: 'both', capabilities: ['reasoning', 'vision'] }),
    ]);

    const reasoning = registry.findByCapabilities(['reasoning']);
    expect(reasoning.length).toBe(2);
    expect(reasoning.map((n) => n.id)).toContain('reasoning');
    expect(reasoning.map((n) => n.id)).toContain('both');

    const vision = registry.findByCapabilities(['vision']);
    expect(vision.length).toBe(2);

    const both = registry.findByCapabilities(['reasoning', 'vision']);
    expect(both.length).toBe(1);
    expect(both[0].id).toBe('both');
  });

  test('filterByTags includes required and excludes excluded', () => {
    const nodes = [
      makeNode({ id: 'private', tags: ['private', 'local'] }),
      makeNode({ id: 'external', tags: ['external'] }),
      makeNode({ id: 'lan', tags: ['private', 'lan'] }),
    ];

    const privateOnly = registry.filterByTags(nodes, ['private']);
    expect(privateOnly.length).toBe(2);
    expect(privateOnly.map((n) => n.id)).toContain('private');
    expect(privateOnly.map((n) => n.id)).toContain('lan');

    const noExternal = registry.filterByTags(nodes, undefined, ['external']);
    expect(noExternal.length).toBe(2);
    expect(noExternal.map((n) => n.id)).not.toContain('external');
  });

  test('filterByHealth respects health states', () => {
    const nodes = [
      makeNode({ id: 'healthy' }),
      makeNode({ id: 'unhealthy', health: { unhealthyAfter: 1 } }),
      makeNode({ id: 'degraded' }),
    ];
    registry.load(nodes);

    registry.updateHealth('healthy', 'healthy');
    // With unhealthyAfter: 1, a single failure reaches the threshold
    registry.updateHealth('unhealthy', 'unhealthy');
    registry.updateHealth('degraded', 'degraded');

    const healthyOnly = registry.filterByHealth(nodes, false);
    expect(healthyOnly.length).toBe(1);
    expect(healthyOnly[0].id).toBe('healthy');

    const withDegraded = registry.filterByHealth(nodes, true);
    expect(withDegraded.length).toBe(2);
  });

  test('sortByPriority orders correctly', () => {
    const nodes = [
      makeNode({ id: 'low', priority: 50 }),
      makeNode({ id: 'high', priority: 1 }),
      makeNode({ id: 'mid', priority: 10 }),
    ];

    const sorted = registry.sortByPriority(nodes);
    expect(sorted[0].id).toBe('high');
    expect(sorted[1].id).toBe('mid');
    expect(sorted[2].id).toBe('low');
  });

  test('health tracking updates correctly with unhealthyAfter threshold', () => {
    // Default makeNode has unhealthyAfter: 3
    registry.load([makeNode({ id: 'node1' })]);

    registry.updateHealth('node1', 'healthy', 50);
    let h = registry.getHealth('node1')!;
    expect(h.state).toBe('healthy');
    expect(h.consecutiveFailures).toBe(0);

    // First failure: stays degraded (below threshold of 3)
    registry.updateHealth('node1', 'unhealthy', undefined, 'timeout');
    h = registry.getHealth('node1')!;
    expect(h.state).toBe('degraded');
    expect(h.consecutiveFailures).toBe(1);
    expect(h.error).toBe('timeout');

    // Second failure: still degraded
    registry.updateHealth('node1', 'unhealthy', undefined, 'timeout');
    h = registry.getHealth('node1')!;
    expect(h.state).toBe('degraded');
    expect(h.consecutiveFailures).toBe(2);

    // Third failure: now reaches threshold, becomes unhealthy
    registry.updateHealth('node1', 'unhealthy', undefined, 'timeout');
    h = registry.getHealth('node1')!;
    expect(h.state).toBe('unhealthy');
    expect(h.consecutiveFailures).toBe(3);

    // Recovery resets to healthy
    registry.updateHealth('node1', 'healthy', 30);
    h = registry.getHealth('node1')!;
    expect(h.state).toBe('healthy');
    expect(h.consecutiveFailures).toBe(0);
  });

  test('node with unhealthyAfter: 3 stays degraded after 1 failure', () => {
    registry.load([makeNode({ id: 'n1', health: { unhealthyAfter: 3 } })]);

    registry.updateHealth('n1', 'unhealthy', undefined, 'connection refused');
    const h = registry.getHealth('n1')!;
    expect(h.state).toBe('degraded');
    expect(h.consecutiveFailures).toBe(1);
    expect(h.error).toBe('connection refused');
  });

  test('node transitions to unhealthy after reaching unhealthyAfter threshold', () => {
    registry.load([makeNode({ id: 'n2', health: { unhealthyAfter: 3 } })]);

    // Failures 1 and 2: degraded
    registry.updateHealth('n2', 'unhealthy', undefined, 'err');
    expect(registry.getHealth('n2')!.state).toBe('degraded');
    registry.updateHealth('n2', 'unhealthy', undefined, 'err');
    expect(registry.getHealth('n2')!.state).toBe('degraded');

    // Failure 3: unhealthy
    registry.updateHealth('n2', 'unhealthy', undefined, 'err');
    const h = registry.getHealth('n2')!;
    expect(h.state).toBe('unhealthy');
    expect(h.consecutiveFailures).toBe(3);
  });

  test('node resets to healthy after success regardless of prior state', () => {
    registry.load([makeNode({ id: 'n3', health: { unhealthyAfter: 2 } })]);

    // Push to unhealthy (2 consecutive failures with threshold 2)
    registry.updateHealth('n3', 'unhealthy', undefined, 'err');
    registry.updateHealth('n3', 'unhealthy', undefined, 'err');
    expect(registry.getHealth('n3')!.state).toBe('unhealthy');
    expect(registry.getHealth('n3')!.consecutiveFailures).toBe(2);

    // A single success resets everything
    registry.updateHealth('n3', 'healthy', 25);
    const h = registry.getHealth('n3')!;
    expect(h.state).toBe('healthy');
    expect(h.consecutiveFailures).toBe(0);
    expect(h.latencyMs).toBe(25);
  });

  describe('applyProfileConstraints', () => {
    test('reverses priority when preferLowerPriority is false', () => {
      const nodes = [
        makeNode({ id: 'high', priority: 1 }),
        makeNode({ id: 'mid', priority: 10 }),
        makeNode({ id: 'low', priority: 50 }),
      ];

      const result = registry.applyProfileConstraints(nodes, { id: 'test', label: 'test', preferLowerPriority: false });
      expect(result[0].id).toBe('low');
      expect(result[1].id).toBe('mid');
      expect(result[2].id).toBe('high');
    });

    test('filters out nodes exceeding maxLatencyMs', () => {
      const nodes = [
        makeNode({ id: 'fast', priority: 1 }),
        makeNode({ id: 'slow', priority: 2 }),
      ];
      registry.load(nodes);
      registry.updateHealth('fast', 'healthy', 50);
      registry.updateHealth('slow', 'healthy', 200);

      const result = registry.applyProfileConstraints(nodes, { id: 'test', label: 'test', maxLatencyMs: 100 });
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('fast');
    });

    test('keeps nodes with no latency data when maxLatencyMs is set', () => {
      const nodes = [
        makeNode({ id: 'unknown', priority: 1 }),
      ];
      registry.load(nodes);

      const result = registry.applyProfileConstraints(nodes, { id: 'test', label: 'test', maxLatencyMs: 100 });
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('unknown');
    });

    test('boosts nodes matching preferredCapabilities', () => {
      const nodes = [
        makeNode({ id: 'fallback', capabilities: ['reasoning'], priority: 1 }),
        makeNode({ id: 'preferred', capabilities: ['reasoning', 'vision'], priority: 10 }),
      ];

      const result = registry.applyProfileConstraints(nodes, { id: 'test', label: 'test', preferredCapabilities: ['vision'] });
      // 'preferred' should jump ahead of 'fallback' despite having worse priority
      expect(result[0].id).toBe('preferred');
      expect(result[1].id).toBe('fallback');
    });
  });
});

import { describe, test, expect } from 'bun:test';
import { handleMetrics } from '../src/api/metrics.js';
import { NodeRegistry } from '../src/registry/registry.js';
import { loadConfig } from '../src/config/loader.js';
import type { NodeDefinition } from '../src/types/index.js';

function makeNode(overrides: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: 'test-node',
    label: 'Test',
    endpoint: 'http://localhost:8080',
    transport: 'http',
    enabled: true,
    capabilities: ['reasoning'],
    tags: [],
    auth: { type: 'none' },
    health: {},
    timeout: {},
    priority: 10,
    providerType: 'openai-compatible',
    ...overrides,
  };
}

describe('metrics endpoint', () => {
  test('returns valid metrics snapshot', async () => {
    const config = loadConfig();
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'n1' }),
      makeNode({ id: 'n2', enabled: false, health: { unhealthyAfter: 1 } }),
    ]);

    registry.updateHealth('n1', 'healthy', 50);
    registry.updateHealth('n2', 'unhealthy');

    const response = handleMetrics(config, registry);
    const data = (await response.json()) as Record<string, any>;

    expect(data.service).toBe('embersynth');
    expect(data.nodes.total).toBe(2);
    expect(data.nodes.enabled).toBe(1);
    expect(data.nodes.healthy).toBe(1);
    expect(data.nodes.unhealthy).toBe(1);
    expect(data.node_details.length).toBe(2);
    expect(data.uptime_ms).toBeGreaterThanOrEqual(0);
  });

  test('includes node details with health info', async () => {
    const config = loadConfig();
    const registry = new NodeRegistry();
    registry.load([makeNode({ id: 'test-1', capabilities: ['reasoning', 'vision'] })]);
    registry.updateHealth('test-1', 'healthy', 42);

    const response = handleMetrics(config, registry);
    const data = (await response.json()) as Record<string, any>;

    const detail = data.node_details[0];
    expect(detail.id).toBe('test-1');
    expect(detail.health).toBe('healthy');
    expect(detail.latency_ms).toBe(42);
    expect(detail.capabilities).toContain('reasoning');
    expect(detail.capabilities).toContain('vision');
  });

  test('lists profiles and synthetic models', async () => {
    const config = loadConfig();
    const registry = new NodeRegistry();
    registry.load([]);

    const response = handleMetrics(config, registry);
    const data = (await response.json()) as Record<string, any>;

    expect(data.profiles.length).toBeGreaterThan(0);
    expect(data.synthetic_models).toContain('fusion-auto');
    expect(data.synthetic_models).toContain('fusion-fast');
  });
});

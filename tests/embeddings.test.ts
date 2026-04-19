import { describe, test, expect } from 'bun:test';
import { NodeRegistry } from '../src/registry/registry.js';
import type { NodeDefinition } from '../src/types/index.js';

function makeNode(overrides: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: 'test-node',
    label: 'Test',
    endpoint: 'http://localhost:8080',
    transport: 'http',
    enabled: true,
    capabilities: ['reasoning'],
    tags: ['private'],
    auth: { type: 'none' },
    health: {},
    timeout: {},
    priority: 10,
    providerType: 'openai-compatible',
    ...overrides,
  };
}

describe('embedding routing', () => {
  test('finds embedding-capable nodes', () => {
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'reasoning-1', capabilities: ['reasoning'] }),
      makeNode({ id: 'embed-1', capabilities: ['embedding'] }),
      makeNode({ id: 'embed-2', capabilities: ['embedding'], priority: 5 }),
    ]);

    const candidates = registry.findByCapabilities(['embedding']);
    expect(candidates.length).toBe(2);
  });

  test('embedding nodes can be filtered by tags', () => {
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'embed-private', capabilities: ['embedding'], tags: ['private'] }),
      makeNode({ id: 'embed-external', capabilities: ['embedding'], tags: ['external'] }),
    ]);

    const all = registry.findByCapabilities(['embedding']);
    const privateOnly = registry.filterByTags(all, ['private']);
    expect(privateOnly.length).toBe(1);
    expect(privateOnly[0].id).toBe('embed-private');
  });

  test('embedding nodes sorted by priority', () => {
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'embed-slow', capabilities: ['embedding'], priority: 50 }),
      makeNode({ id: 'embed-fast', capabilities: ['embedding'], priority: 1 }),
    ]);

    const candidates = registry.findByCapabilities(['embedding']);
    const sorted = registry.sortByPriority(candidates);
    expect(sorted[0].id).toBe('embed-fast');
  });
});

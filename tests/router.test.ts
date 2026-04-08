import { describe, test, expect } from 'bun:test';
import { classifyRequest } from '../src/router/classifier.js';
import { buildPlan } from '../src/router/planner.js';
import { NodeRegistry } from '../src/registry/registry.js';
import { DEFAULT_POLICY, DEFAULT_PROFILES } from '../src/config/defaults.js';
import type { NodeDefinition, RoutingProfile } from '../src/types/index.js';

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

const autoProfile = DEFAULT_PROFILES.find((p) => p.id === 'auto')!;
const fastProfile = DEFAULT_PROFILES.find((p) => p.id === 'fast')!;
const privateProfile = DEFAULT_PROFILES.find((p) => p.id === 'private')!;

describe('request classifier', () => {
  test('classifies text-only request', () => {
    const result = classifyRequest([{ role: 'user', content: 'Hello world' }]);
    expect(result.hasVisionContent).toBe(false);
    expect(result.hasRetrievalNeed).toBe(false);
    expect(result.hasMemoryNeed).toBe(false);
    expect(result.requiredCapabilities).toContain('reasoning');
    expect(result.requiredCapabilities).not.toContain('vision');
    expect(result.suggestedStages.length).toBe(1);
  });

  test('classifies request with image_url content', () => {
    const result = classifyRequest([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
        ],
      },
    ]);
    expect(result.hasVisionContent).toBe(true);
    expect(result.requiredCapabilities).toContain('vision');
    expect(result.requiredCapabilities).toContain('reasoning');
    expect(result.suggestedStages.length).toBe(2);
  });

  test('detects image URL in text content', () => {
    const result = classifyRequest([
      { role: 'user', content: 'Analyze this screenshot: https://example.com/image.png' },
    ]);
    expect(result.hasVisionContent).toBe(true);
  });

  test('estimates complexity by message length', () => {
    const simple = classifyRequest([{ role: 'user', content: 'Hi' }]);
    expect(simple.estimatedComplexity).toBe('simple');

    const moderate = classifyRequest([{ role: 'user', content: 'x'.repeat(1000) }]);
    expect(moderate.estimatedComplexity).toBe('moderate');

    const complex = classifyRequest([{ role: 'user', content: 'x'.repeat(5000) }]);
    expect(complex.estimatedComplexity).toBe('complex');
  });

  test('detects retrieval need', () => {
    const result = classifyRequest([
      { role: 'user', content: 'Search the knowledge base for information about embeddings' },
    ]);
    expect(result.hasRetrievalNeed).toBe(true);
    expect(result.requiredCapabilities).toContain('retrieval');
  });

  test('detects memory need', () => {
    const result = classifyRequest([
      { role: 'user', content: 'Do you remember what we discussed last time about the API?' },
    ]);
    expect(result.hasMemoryNeed).toBe(true);
    expect(result.requiredCapabilities).toContain('memory');
  });

  test('builds multi-stage pipeline for memory + retrieval + reasoning', () => {
    const result = classifyRequest([
      { role: 'user', content: 'Remember what we discussed previously and search the docs for related information' },
    ]);
    expect(result.hasMemoryNeed).toBe(true);
    expect(result.hasRetrievalNeed).toBe(true);
    // Stages: memory -> retrieval -> reasoning
    expect(result.suggestedStages.length).toBe(3);
    expect(result.suggestedStages[0]).toEqual(['memory']);
    expect(result.suggestedStages[1]).toEqual(['retrieval']);
    expect(result.suggestedStages[2]).toEqual(['reasoning']);
  });

  test('builds 4-stage pipeline for memory + retrieval + vision + reasoning', () => {
    const result = classifyRequest([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Recall what we discussed previously and search the knowledge base for related information, then analyze this image' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
        ],
      },
    ]);
    expect(result.suggestedStages.length).toBe(4);
    expect(result.suggestedStages.map((s) => s[0])).toEqual(['memory', 'retrieval', 'vision', 'reasoning']);
  });
});

describe('planner', () => {
  test('builds single-stage plan for text request', () => {
    const registry = new NodeRegistry();
    registry.load([makeNode({ id: 'r1', capabilities: ['reasoning'] })]);

    const classification = classifyRequest([{ role: 'user', content: 'Hello' }]);
    const result = buildPlan(classification, autoProfile, DEFAULT_POLICY, registry);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.stages.length).toBe(1);
      expect(result.plan.stages[0].capability).toBe('reasoning');
      expect(result.plan.stages[0].nodeId).toBe('r1');
      expect(result.plan.requiresSynthesis).toBe(false);
    }
  });

  test('builds multi-stage plan for vision request', () => {
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'v1', capabilities: ['vision'], priority: 5 }),
      makeNode({ id: 'r1', capabilities: ['reasoning'], priority: 1 }),
    ]);

    const classification = classifyRequest([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
        ],
      },
    ]);

    const result = buildPlan(classification, autoProfile, DEFAULT_POLICY, registry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.stages.length).toBe(2);
      expect(result.plan.stages[0].capability).toBe('vision');
      expect(result.plan.stages[1].capability).toBe('reasoning');
      expect(result.plan.requiresSynthesis).toBe(true);
    }
  });

  test('fast profile returns capability-gap error for vision request', () => {
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'v1', capabilities: ['vision'], priority: 5 }),
      makeNode({ id: 'r1', capabilities: ['reasoning'], priority: 1 }),
    ]);

    const classification = classifyRequest([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Quick look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
        ],
      },
    ]);

    const result = buildPlan(classification, fastProfile, DEFAULT_POLICY, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('capability-gap');
      expect(result.error.capability).toBe('vision');
      expect(result.error.message).toContain('maxStages=1');
    }
  });

  test('fast profile works for text-only request', () => {
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'r1', capabilities: ['reasoning'], priority: 1 }),
    ]);

    const classification = classifyRequest([{ role: 'user', content: 'Hello' }]);
    const result = buildPlan(classification, fastProfile, DEFAULT_POLICY, registry);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.stages.length).toBe(1);
      expect(result.plan.stages[0].capability).toBe('reasoning');
      expect(result.plan.stages[0].nodeId).toBe('r1');
    }
  });

  test('private profile excludes non-private nodes', () => {
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'r-private', capabilities: ['reasoning'], tags: ['private'] }),
      makeNode({ id: 'r-external', capabilities: ['reasoning'], tags: ['external'] }),
    ]);

    const classification = classifyRequest([{ role: 'user', content: 'Hello' }]);
    const result = buildPlan(classification, privateProfile, DEFAULT_POLICY, registry);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.stages[0].nodeId).toBe('r-private');
    }
  });

  test('fails when no nodes match profile', () => {
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'r-external', capabilities: ['reasoning'], tags: ['external'] }),
    ]);

    const classification = classifyRequest([{ role: 'user', content: 'Hello' }]);
    const result = buildPlan(classification, privateProfile, DEFAULT_POLICY, registry);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('no-nodes');
      expect(result.error.capability).toBe('reasoning');
    }
  });

  test('selects highest priority node', () => {
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'r-low', capabilities: ['reasoning'], tags: ['private'], priority: 50 }),
      makeNode({ id: 'r-high', capabilities: ['reasoning'], tags: ['private'], priority: 1 }),
    ]);

    const classification = classifyRequest([{ role: 'user', content: 'Hello' }]);
    const result = buildPlan(classification, autoProfile, DEFAULT_POLICY, registry);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.stages[0].nodeId).toBe('r-high');
    }
  });

  test('skips unhealthy nodes when policy requires healthy', () => {
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'r-sick', capabilities: ['reasoning'], priority: 1 }),
      makeNode({ id: 'r-ok', capabilities: ['reasoning'], priority: 10 }),
    ]);
    registry.updateHealth('r-sick', 'unhealthy');
    registry.updateHealth('r-ok', 'healthy');

    const classification = classifyRequest([{ role: 'user', content: 'Hello' }]);
    const result = buildPlan(classification, autoProfile, DEFAULT_POLICY, registry);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.stages[0].nodeId).toBe('r-ok');
    }
  });

  test('excludeNodeIds parameter skips specified nodes', () => {
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'r1', capabilities: ['reasoning'], priority: 1 }),
      makeNode({ id: 'r2', capabilities: ['reasoning'], priority: 10 }),
    ]);

    const classification = classifyRequest([{ role: 'user', content: 'Hello' }]);
    const excluded = new Set(['r1']);
    const result = buildPlan(classification, autoProfile, DEFAULT_POLICY, registry, excluded);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.stages[0].nodeId).toBe('r2');
    }
  });

  test('preferLowerPriority false reverses priority sort', () => {
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'r-low', capabilities: ['reasoning'], priority: 1 }),
      makeNode({ id: 'r-high', capabilities: ['reasoning'], priority: 50 }),
    ]);

    const profile: RoutingProfile = {
      id: 'reverse-priority',
      label: 'Reverse Priority',
      preferLowerPriority: false,
    };

    const classification = classifyRequest([{ role: 'user', content: 'Hello' }]);
    const result = buildPlan(classification, profile, DEFAULT_POLICY, registry);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // With preferLowerPriority=false, the highest priority number (50) should be selected
      expect(result.plan.stages[0].nodeId).toBe('r-high');
    }
  });

  test('maxLatencyMs filters slow nodes', () => {
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'r-fast', capabilities: ['reasoning'], priority: 10 }),
      makeNode({ id: 'r-slow', capabilities: ['reasoning'], priority: 1 }),
    ]);

    // r-slow has the best priority but high latency
    registry.updateHealth('r-slow', 'healthy', 500);
    registry.updateHealth('r-fast', 'healthy', 50);

    const profile: RoutingProfile = {
      id: 'latency-limited',
      label: 'Latency Limited',
      maxLatencyMs: 200,
    };

    const classification = classifyRequest([{ role: 'user', content: 'Hello' }]);
    const result = buildPlan(classification, profile, DEFAULT_POLICY, registry);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // r-slow (priority 1) should be filtered out due to 500ms latency > 200ms limit
      expect(result.plan.stages[0].nodeId).toBe('r-fast');
    }
  });

  test('preferredCapabilities boosts matching nodes', () => {
    const registry = new NodeRegistry();
    registry.load([
      makeNode({ id: 'r-plain', capabilities: ['reasoning'], priority: 1 }),
      makeNode({ id: 'r-vision', capabilities: ['reasoning', 'vision'], priority: 10 }),
    ]);

    const profile: RoutingProfile = {
      id: 'prefer-vision',
      label: 'Prefer Vision',
      preferredCapabilities: ['vision'],
    };

    const classification = classifyRequest([{ role: 'user', content: 'Hello' }]);
    const result = buildPlan(classification, profile, DEFAULT_POLICY, registry);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // r-vision has worse priority (10 vs 1) but has the preferred capability
      expect(result.plan.stages[0].nodeId).toBe('r-vision');
    }
  });
});

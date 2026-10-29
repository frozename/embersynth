import { describe, test, expect } from 'bun:test';
import { compressEvidence } from '../src/evidence/compressor.js';
import type { EvidenceBundle, RoutingPolicy } from '../src/types/index.js';

const basePolicy: RoutingPolicy = {
  fallbackEnabled: true,
  maxRetries: 2,
  retryDelayMs: 500,
  requireHealthy: true,
  evidenceCompression: false,
};

function makeBundle(contentLength: number): EvidenceBundle {
  return {
    planId: 'test-plan',
    items: [
      {
        stageIndex: 0,
        nodeId: 'node-1',
        capability: 'vision',
        content: 'x'.repeat(contentLength),
        durationMs: 100,
        timestamp: Date.now(),
      },
    ],
    totalDurationMs: 100,
  };
}

const LOGIN_SENTENCE =
  'The screenshot shows a login form with two inputs and a blue submit button below them';
const TRUNCATION_MARKER = '\n\n[... truncated ...]\n\n';

function makeContentBundle(content: string): EvidenceBundle {
  return {
    planId: 'small-limit-plan',
    items: [
      {
        stageIndex: 0,
        nodeId: 'node-1',
        capability: 'vision',
        content,
        durationMs: 100,
        timestamp: Date.now(),
      },
    ],
    totalDurationMs: 100,
  };
}

describe('evidence compression', () => {
  test('passes through when compression is disabled', () => {
    const bundle = makeBundle(10000);
    const result = compressEvidence(bundle, basePolicy);
    expect(result.items[0].content.length).toBe(10000);
  });

  test('passes through short content even when compression enabled', () => {
    const policy = { ...basePolicy, evidenceCompression: true, evidenceMaxLength: 5000 };
    const bundle = makeBundle(100);
    const result = compressEvidence(bundle, policy);
    expect(result.items[0].content.length).toBe(100);
  });

  test('compresses long content when enabled', () => {
    const policy = { ...basePolicy, evidenceCompression: true, evidenceMaxLength: 500 };
    const bundle = makeBundle(10000);
    const result = compressEvidence(bundle, policy);
    expect(result.items[0].content.length).toBeLessThanOrEqual(500);
  });

  test('marks compressed items with metadata', () => {
    const policy = { ...basePolicy, evidenceCompression: true, evidenceMaxLength: 500 };
    const bundle = makeBundle(10000);
    const result = compressEvidence(bundle, policy);
    expect(result.items[0].metadata?.compressed).toBe(true);
    expect(result.items[0].metadata?.originalLength).toBe(10000);
  });

  test('uses default max length when not specified', () => {
    const policy = { ...basePolicy, evidenceCompression: true };
    const bundle = makeBundle(10000);
    const result = compressEvidence(bundle, policy);
    // Default is 4000, so 10000 char content should be compressed
    expect(result.items[0].content.length).toBeLessThanOrEqual(4000);
  });

  test('preserves bundle structure', () => {
    const policy = { ...basePolicy, evidenceCompression: true, evidenceMaxLength: 50 };
    const bundle: EvidenceBundle = {
      planId: 'multi-plan',
      items: [
        {
          stageIndex: 0,
          nodeId: 'node-1',
          capability: 'vision',
          content: 'Short content',
          durationMs: 50,
          timestamp: Date.now(),
        },
        {
          stageIndex: 1,
          nodeId: 'node-2',
          capability: 'retrieval',
          content: 'x'.repeat(1000),
          durationMs: 100,
          timestamp: Date.now(),
        },
      ],
      totalDurationMs: 150,
    };

    const result = compressEvidence(bundle, policy);
    expect(result.planId).toBe('multi-plan');
    expect(result.items.length).toBe(2);
    // First item is short, should pass through
    expect(result.items[0].content).toBe('Short content');
    // Second item is long, should be compressed
    expect(result.items[1].content.length).toBeLessThanOrEqual(50);
  });
});

describe('evidence compression below the truncation marker (#15)', () => {
  const inputs: { name: string; content: string }[] = [
    { name: '100 x characters', content: 'x'.repeat(100) },
    { name: '85-char single sentence', content: LOGIN_SENTENCE },
  ];
  const limits: number[] = [1, 20, 30, 40, 41, 42, 50];

  for (const input of inputs) {
    for (const limit of limits) {
      test(`${input.name} with evidenceMaxLength ${limit} stays within the limit`, () => {
        const policy: RoutingPolicy = {
          ...basePolicy,
          evidenceCompression: true,
          evidenceMaxLength: limit,
        };
        const result = compressEvidence(makeContentBundle(input.content), policy);
        const out = result.items[0].content;
        expect(out.length).toBeLessThanOrEqual(limit);
        expect(out.length).toBeLessThan(input.content.length);
        expect(result.items[0].metadata?.compressed).toBe(true);
        expect(result.items[0].metadata?.originalLength).toBe(input.content.length);
      });
    }
  }

  test('a limit below 42 keeps the head of the content without the marker', () => {
    const policy: RoutingPolicy = { ...basePolicy, evidenceCompression: true, evidenceMaxLength: 20 };
    const result = compressEvidence(makeContentBundle(LOGIN_SENTENCE), policy);
    expect(result.items[0].content).toBe(LOGIN_SENTENCE.slice(0, 20));
  });

  test('a limit of 42 or more keeps the head + marker + tail output', () => {
    const policy: RoutingPolicy = { ...basePolicy, evidenceCompression: true, evidenceMaxLength: 50 };
    const result = compressEvidence(makeContentBundle('x'.repeat(100)), policy);
    expect(result.items[0].content).toBe('x'.repeat(5) + TRUNCATION_MARKER + 'x'.repeat(5));
  });

  const invalidLimits: number[] = [0, -5, Number.NaN, Number.POSITIVE_INFINITY];
  for (const limit of invalidLimits) {
    test(`evidenceMaxLength ${limit} falls back to the default 4000`, () => {
      const bundle = makeBundle(10000);
      const defaultPolicy: RoutingPolicy = { ...basePolicy, evidenceCompression: true };
      const expected = compressEvidence(bundle, defaultPolicy).items[0].content;
      expect(expected.length).toBe(3983);
      const policy: RoutingPolicy = {
        ...basePolicy,
        evidenceCompression: true,
        evidenceMaxLength: limit,
      };
      expect(compressEvidence(bundle, policy).items[0].content).toBe(expected);
    });
  }
});

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

import { describe, test, expect } from 'bun:test';
import { TraceStore, type TraceEvent } from '../src/tracing/store.js';
import { generateTraceId, createTraceContext } from '../src/tracing/context.js';

describe('TraceStore', () => {
  test('records and retrieves events', () => {
    const store = new TraceStore();
    const traceId = 'trace-test-1';

    const event1: TraceEvent = {
      traceId,
      timestamp: Date.now(),
      phase: 'classify',
      data: { capabilities: ['reasoning'], complexity: 'simple' },
    };

    const event2: TraceEvent = {
      traceId,
      timestamp: Date.now() + 1,
      phase: 'plan',
      data: { planId: 'plan-1', stages: 1 },
    };

    store.record(event1);
    store.record(event2);

    const events = store.getTrace(traceId);
    expect(events).toBeDefined();
    expect(events!.length).toBe(2);
    expect(events![0].phase).toBe('classify');
    expect(events![1].phase).toBe('plan');
    expect(events![0].data.capabilities).toEqual(['reasoning']);
  });

  test('evicts oldest traces when full', () => {
    const store = new TraceStore(3);

    store.record({ traceId: 'trace-a', timestamp: 1, phase: 'classify', data: {} });
    store.record({ traceId: 'trace-b', timestamp: 2, phase: 'classify', data: {} });
    store.record({ traceId: 'trace-c', timestamp: 3, phase: 'classify', data: {} });

    // Buffer is full (3 traces). Adding a 4th should evict trace-a.
    store.record({ traceId: 'trace-d', timestamp: 4, phase: 'classify', data: {} });

    expect(store.getTrace('trace-a')).toBeUndefined();
    expect(store.getTrace('trace-b')).toBeDefined();
    expect(store.getTrace('trace-c')).toBeDefined();
    expect(store.getTrace('trace-d')).toBeDefined();
  });

  test('listTraces returns summary', () => {
    const store = new TraceStore();

    store.record({ traceId: 'trace-x', timestamp: 100, phase: 'classify', data: {} });
    store.record({ traceId: 'trace-x', timestamp: 101, phase: 'plan', data: {} });
    store.record({ traceId: 'trace-y', timestamp: 200, phase: 'classify', data: {} });

    const list = store.listTraces();
    expect(list.length).toBe(2);

    // Most recent first
    expect(list[0].traceId).toBe('trace-y');
    expect(list[0].startedAt).toBe(200);
    expect(list[0].eventCount).toBe(1);

    expect(list[1].traceId).toBe('trace-x');
    expect(list[1].startedAt).toBe(100);
    expect(list[1].eventCount).toBe(2);
  });

  test('listTraces respects limit parameter', () => {
    const store = new TraceStore();

    store.record({ traceId: 'trace-1', timestamp: 1, phase: 'classify', data: {} });
    store.record({ traceId: 'trace-2', timestamp: 2, phase: 'classify', data: {} });
    store.record({ traceId: 'trace-3', timestamp: 3, phase: 'classify', data: {} });

    const list = store.listTraces(2);
    expect(list.length).toBe(2);
    expect(list[0].traceId).toBe('trace-3');
    expect(list[1].traceId).toBe('trace-2');
  });

  test('clear removes all traces', () => {
    const store = new TraceStore();

    store.record({ traceId: 'trace-1', timestamp: 1, phase: 'classify', data: {} });
    store.record({ traceId: 'trace-2', timestamp: 2, phase: 'plan', data: {} });

    expect(store.listTraces().length).toBe(2);

    store.clear();

    expect(store.listTraces().length).toBe(0);
    expect(store.getTrace('trace-1')).toBeUndefined();
    expect(store.getTrace('trace-2')).toBeUndefined();
  });
});

describe('generateTraceId', () => {
  test('returns unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateTraceId());
    }
    expect(ids.size).toBe(100);
  });

  test('follows expected format', () => {
    const id = generateTraceId();
    expect(id).toMatch(/^trace-\d+-[a-z0-9]+$/);
  });
});

describe('createTraceContext', () => {
  test('records with correct traceId', () => {
    const store = new TraceStore();
    const traceId = 'trace-ctx-test';
    const ctx = createTraceContext(store, traceId);

    expect(ctx.traceId).toBe(traceId);

    ctx.record('classify', { capabilities: ['reasoning'] });
    ctx.record('plan', { planId: 'p1', stages: 1 });

    const events = store.getTrace(traceId);
    expect(events).toBeDefined();
    expect(events!.length).toBe(2);
    expect(events![0].traceId).toBe(traceId);
    expect(events![0].phase).toBe('classify');
    expect(events![0].data.capabilities).toEqual(['reasoning']);
    expect(events![1].traceId).toBe(traceId);
    expect(events![1].phase).toBe('plan');
    expect(events![1].timestamp).toBeGreaterThan(0);
  });
});

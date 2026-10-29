import { describe, test, expect, afterEach, setSystemTime } from 'bun:test';
import type { EmberSynthConfig, RoutingProfile } from '../src/types/index.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { NodeRegistry } from '../src/registry/registry.js';
import { TraceStore, type TraceEvent } from '../src/tracing/store.js';
import { handleGetTrace, handleListTraces } from '../src/api/traces.js';
import { handleModels } from '../src/api/models.js';

// Pins the /v1/traces and /v1/models handlers (src/api/traces.ts, src/api/models.ts)
// by calling them in-process: no server, network or sleep. handleModels reads
// Date.now(), so its cases fix the clock with setSystemTime and reset it afterwards.

type TraceSummary = { traceId: string; startedAt: number; eventCount: number };
type TraceListBody = { traces: TraceSummary[] };
type TraceBody = { traceId: string; events: TraceEvent[] };
type ErrorBody = { error: { message: string; type: string } };
type ModelEntry = { id: string; object: string; created: number; owned_by: string; description?: string };
type ModelListBody = { object: string; data: ModelEntry[] };

const BASE_TS = 1700000000000;
const FIXED_MS = Date.UTC(2026, 0, 2, 3, 4, 5, 678);

/** A store holding `count` one-event traces trace-0 .. trace-<count-1>, recorded oldest first. */
function storeWith(count: number): TraceStore {
  const store = new TraceStore();
  for (let i = 0; i < count; i++) {
    store.record({ traceId: `trace-${i}`, timestamp: BASE_TS + i, phase: 'classify', data: {} });
  }
  return store;
}

/** Calls handleListTraces with `query` appended to /v1/traces and returns the parsed body. */
async function listWith(store: TraceStore, query: string): Promise<TraceListBody> {
  const res = handleListTraces(store, new URL(`http://localhost/v1/traces${query}`));
  expect(res.status).toBe(200);
  return (await res.json()) as TraceListBody;
}

function configWith(profiles: RoutingProfile[], syntheticModels: Record<string, string>): EmberSynthConfig {
  return { ...DEFAULT_CONFIG, profiles, syntheticModels };
}

describe('handleListTraces', () => {
  test('returns the default 50 traces when no limit is given', async () => {
    const body = await listWith(storeWith(60), '');

    expect(body.traces.length).toBe(50);
    expect(body.traces[0].traceId).toBe('trace-59');
  });

  test('clamps a limit above 500 to 500', async () => {
    const body = await listWith(storeWith(501), '?limit=1000');

    expect(body.traces.length).toBe(500);
    expect(body.traces[0].traceId).toBe('trace-500');
    expect(body.traces[499].traceId).toBe('trace-1');
  });

  test('falls back to 50 for a zero, negative, non-numeric or empty limit', async () => {
    const store = storeWith(60);

    for (const query of ['?limit=0', '?limit=-5', '?limit=abc', '?limit=']) {
      const body = await listWith(store, query);
      expect({ query, count: body.traces.length }).toEqual({ query, count: 50 });
    }
  });

  test('parses the numeric prefix of a limit such as 10abc', async () => {
    const body = await listWith(storeWith(60), '?limit=10abc');

    expect(body.traces.length).toBe(10);
  });

  test('returns the newest traces first with startedAt and eventCount', async () => {
    const store = storeWith(5);
    store.record({ traceId: 'trace-4', timestamp: BASE_TS + 100, phase: 'plan', data: { stages: 1 } });

    const body = await listWith(store, '?limit=3');

    expect(body.traces).toEqual([
      { traceId: 'trace-4', startedAt: BASE_TS + 4, eventCount: 2 },
      { traceId: 'trace-3', startedAt: BASE_TS + 3, eventCount: 1 },
      { traceId: 'trace-2', startedAt: BASE_TS + 2, eventCount: 1 },
    ]);
  });
});

describe('handleGetTrace', () => {
  test('returns 200 with the recorded events for a known trace id', async () => {
    const store = new TraceStore();
    const first: TraceEvent = { traceId: 'known', timestamp: BASE_TS, phase: 'classify', data: { capabilities: ['reasoning'] } };
    const second: TraceEvent = { traceId: 'known', timestamp: BASE_TS + 1, phase: 'execute-complete', data: { ok: true } };
    store.record(first);
    store.record(second);

    const res = handleGetTrace(store, 'known');

    expect(res.status).toBe(200);
    const body = (await res.json()) as TraceBody;
    expect(body).toEqual({ traceId: 'known', events: [first, second] });
  });

  test('returns 404 with a not_found error for an unknown trace id', async () => {
    const res = handleGetTrace(storeWith(1), 'nope');

    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body).toEqual({ error: { message: 'Trace "nope" not found', type: 'not_found' } });
  });
});

describe('handleModels', () => {
  afterEach(() => {
    setSystemTime();
  });

  test('lists one model per synthetic model in insertion order with the profile description', async () => {
    setSystemTime(new Date(FIXED_MS));
    const config = configWith(
      [
        { id: 'p-alpha', label: 'Alpha', description: 'Alpha profile' },
        { id: 'p-beta', label: 'Beta', description: 'Beta profile' },
      ],
      { 'model-b': 'p-beta', 'model-a': 'p-alpha', 'model-orphan': 'p-missing' },
    );

    const res = handleModels(config, new NodeRegistry());

    expect(res.status).toBe(200);
    const body = (await res.json()) as ModelListBody;
    const created = Math.floor(FIXED_MS / 1000);
    expect(body).toEqual({
      object: 'list',
      data: [
        { id: 'model-b', object: 'model', created, owned_by: 'embersynth', description: 'Beta profile' },
        { id: 'model-a', object: 'model', created, owned_by: 'embersynth', description: 'Alpha profile' },
        { id: 'model-orphan', object: 'model', created, owned_by: 'embersynth' },
      ],
    });
    expect(Object.keys(body.data[2])).toEqual(['id', 'object', 'created', 'owned_by']);
  });

  test('returns an empty list when no synthetic models are configured', async () => {
    const res = handleModels(configWith(DEFAULT_CONFIG.profiles, {}), new NodeRegistry());

    const body = (await res.json()) as ModelListBody;
    expect(body).toEqual({ object: 'list', data: [] });
  });
});

import { describe, test, expect } from 'bun:test';
import { healthAll, type NodeHealthProbe } from '../src/health/index.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { EmberSynthConfig, NodeDefinition } from '../src/types/index.js';

// Pins healthAll (src/health/index.ts), the probe behind embersynth.health.all.
// Every fetch is a recording fake that settles at once: no network, clock or sleep.

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

function configWith(nodes: NodeDefinition[]): EmberSynthConfig {
  return { ...DEFAULT_CONFIG, nodes };
}

interface FetchCall {
  url: string;
  method: string | undefined;
  signal: AbortSignal | null | undefined;
  abortedAtCall: boolean;
}

/** A number resolves with that HTTP status; an Error or a string rejects with it. */
type FakeOutcome = number | Error | string;

interface FakeFetch {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function fakeFetch(outcomes: Record<string, FakeOutcome>): FakeFetch {
  const calls: FetchCall[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    calls.push({
      url,
      method: init?.method,
      signal: init?.signal,
      abortedAtCall: init?.signal?.aborted ?? false,
    });
    const outcome = outcomes[url];
    if (outcome === undefined) return Promise.reject(new Error(`unexpected url ${url}`));
    if (typeof outcome === 'number') {
      return Promise.resolve(new Response(null, { status: outcome }));
    }
    return Promise.reject(outcome);
  };
  return { fetchImpl: Object.assign(impl, { preconnect: fetch.preconnect.bind(fetch) }), calls };
}

function expectLatency(probe: NodeHealthProbe): void {
  expect(typeof probe.latencyMs).toBe('number');
  expect(probe.latencyMs ?? -1).toBeGreaterThanOrEqual(0);
}

describe('healthAll URL building', () => {
  test('joins endpoint and health path, trimming trailing slashes and adding a leading slash', async () => {
    const a = makeNode({ id: 'a', endpoint: 'http://a:1/' });
    const b = makeNode({
      id: 'b',
      endpoint: 'http://b:2//',
      health: { endpoint: 'healthz', intervalMs: 30000, timeoutMs: 5000, unhealthyAfter: 3 },
    });
    const c = makeNode({ id: 'c', endpoint: 'http://c:3', health: {} });
    const fake = fakeFetch({
      'http://a:1/health': 200,
      'http://b:2/healthz': 200,
      'http://c:3/health': 200,
    });

    const report = await healthAll(configWith([a, b, c]), { fetch: fake.fetchImpl });

    expect(fake.calls.map((call) => call.url)).toEqual([
      'http://a:1/health',
      'http://b:2/healthz',
      'http://c:3/health',
    ]);
    expect(report.worst).toBe('ok');
    for (const call of fake.calls) {
      expect(call.method).toBe('GET');
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.abortedAtCall).toBe(false);
    }
  });
});

describe('healthAll node selection', () => {
  test('without opts.nodes only enabled config nodes are probed and reported', async () => {
    const on = makeNode({ id: 'on', endpoint: 'http://on:1' });
    const off = makeNode({ id: 'off', endpoint: 'http://off:1', enabled: false });
    const fake = fakeFetch({ 'http://on:1/health': 200, 'http://off:1/health': 200 });

    const report = await healthAll(configWith([on, off]), { fetch: fake.fetchImpl });

    expect(fake.calls.map((call) => call.url)).toEqual(['http://on:1/health']);
    expect(report.nodes.map((probe) => probe.id)).toEqual(['on']);
    expect(report.worst).toBe('ok');
  });

  test('opts.nodes replaces the config fleet and probes disabled nodes too', async () => {
    const inConfig = makeNode({ id: 'in-config', endpoint: 'http://cfg:1' });
    const off = makeNode({ id: 'off', endpoint: 'http://off:1', enabled: false });
    const extra = makeNode({ id: 'extra', endpoint: 'http://extra:1' });
    const fake = fakeFetch({
      'http://cfg:1/health': 200,
      'http://off:1/health': 200,
      'http://extra:1/health': 200,
    });

    const report = await healthAll(configWith([inConfig]), {
      nodes: [off, extra],
      fetch: fake.fetchImpl,
    });

    expect(fake.calls.map((call) => call.url)).toEqual([
      'http://off:1/health',
      'http://extra:1/health',
    ]);
    expect(report.nodes.map((probe) => probe.id)).toEqual(['off', 'extra']);
  });

  test('an empty or all-disabled fleet reports ok and never calls fetch', async () => {
    const fake = fakeFetch({});
    const off = makeNode({ id: 'off', endpoint: 'http://off:1', enabled: false });

    const empty = await healthAll(configWith([]), { fetch: fake.fetchImpl });
    const allOff = await healthAll(configWith([off]), { fetch: fake.fetchImpl });

    expect(empty).toEqual({ nodes: [], worst: 'ok' });
    expect(allOff).toEqual({ nodes: [], worst: 'ok' });
    expect(fake.calls.length).toBe(0);
  });
});

describe('healthAll severity rollup', () => {
  test('all nodes answering 2xx roll up to ok with reachable probes and no error', async () => {
    const fake = fakeFetch({ 'http://a:1/health': 200, 'http://b:1/health': 204 });
    const nodes = [
      makeNode({ id: 'a', endpoint: 'http://a:1' }),
      makeNode({ id: 'b', endpoint: 'http://b:1' }),
    ];

    const report = await healthAll(configWith(nodes), { fetch: fake.fetchImpl });

    expect(report.worst).toBe('ok');
    expect(report.nodes.map((probe) => probe.id)).toEqual(['a', 'b']);
    for (const probe of report.nodes) {
      expect(probe.reachable).toBe(true);
      expect(probe.error).toBeUndefined();
      expectLatency(probe);
    }
  });

  test('one non-2xx node out of two rolls up to degraded', async () => {
    const fake = fakeFetch({ 'http://up:1/health': 200, 'http://sick:1/health': 503 });
    const nodes = [
      makeNode({ id: 'up', endpoint: 'http://up:1' }),
      makeNode({ id: 'sick', endpoint: 'http://sick:1' }),
    ];

    const report = await healthAll(configWith(nodes), { fetch: fake.fetchImpl });

    expect(report.worst).toBe('degraded');
    const [up, sick] = report.nodes;
    expect(up.id).toBe('up');
    expect(up.reachable).toBe(true);
    expect(sick.id).toBe('sick');
    expect(sick.reachable).toBe(false);
    expect(sick.error).toBe('HTTP 503');
    expectLatency(sick);
  });

  test('every node failing rolls up to down and keeps the rejection message', async () => {
    const fake = fakeFetch({
      'http://five:1/health': 500,
      'http://refused:1/health': new Error('connect ECONNREFUSED'),
    });
    const nodes = [
      makeNode({ id: 'five', endpoint: 'http://five:1' }),
      makeNode({ id: 'refused', endpoint: 'http://refused:1' }),
    ];

    const report = await healthAll(configWith(nodes), { fetch: fake.fetchImpl });

    expect(report.worst).toBe('down');
    const [five, refused] = report.nodes;
    expect(five.reachable).toBe(false);
    expect(five.error).toBe('HTTP 500');
    expect(refused.reachable).toBe(false);
    expect(refused.error).toBe('connect ECONNREFUSED');
    expectLatency(refused);
  });

  test('a non-Error rejection is reported as its string form', async () => {
    const fake = fakeFetch({ 'http://odd:1/health': 'boom' });

    const report = await healthAll(configWith([makeNode({ id: 'odd', endpoint: 'http://odd:1' })]), {
      fetch: fake.fetchImpl,
    });

    expect(report.worst).toBe('down');
    expect(report.nodes[0].reachable).toBe(false);
    expect(report.nodes[0].error).toBe('boom');
  });
});

describe('healthAll probe order', () => {
  test('probes are reported in input order even when an earlier probe settles last', async () => {
    const calls: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const impl = async (input: string | URL | Request): Promise<Response> => {
      const url = urlOf(input);
      calls.push(url);
      if (url === 'http://z:1/health') {
        await firstGate;
        return new Response(null, { status: 200 });
      }
      if (url === 'http://m:1/health') releaseFirst();
      return new Response(null, { status: 503 });
    };
    const fetchImpl: typeof fetch = Object.assign(impl, {
      preconnect: fetch.preconnect.bind(fetch),
    });
    const nodes = [
      makeNode({ id: 'z', endpoint: 'http://z:1' }),
      makeNode({ id: 'a', endpoint: 'http://a:1' }),
      makeNode({ id: 'm', endpoint: 'http://m:1' }),
    ];

    const report = await healthAll(configWith(nodes), { fetch: fetchImpl });

    expect(calls).toEqual(['http://z:1/health', 'http://a:1/health', 'http://m:1/health']);
    expect(report.nodes.map((probe) => probe.id)).toEqual(['z', 'a', 'm']);
    expect(report.nodes.map((probe) => probe.reachable)).toEqual([true, false, false]);
    expect(report.worst).toBe('degraded');
  });
});

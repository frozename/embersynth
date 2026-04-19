import type { EmberSynthConfig, NodeDefinition } from '../types/index.js';

/**
 * Lightweight reachability probe for `embersynth.health.all`. Unlike
 * `src/health/monitor.ts` (which drives the periodic adapter-level
 * health check and updates the registry), this module is a one-shot
 * synchronous-flavored probe suitable for an MCP tool handler:
 * GET `<endpoint><healthEndpoint>` with a 2s timeout, record
 * reachability + latency, roll up a fleet severity.
 *
 * Returns a pure report; no registry mutation.
 */

export interface NodeHealthProbe {
  id: string;
  reachable: boolean;
  latencyMs?: number;
  error?: string;
}

export interface HealthReport {
  nodes: NodeHealthProbe[];
  worst: 'ok' | 'degraded' | 'down';
}

const DEFAULT_TIMEOUT_MS = 2_000;

function healthUrl(node: NodeDefinition): string {
  const base = node.endpoint.replace(/\/+$/, '');
  const path = node.health.endpoint ?? '/health';
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

async function probeNode(
  node: NodeDefinition,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<NodeHealthProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetchImpl(healthUrl(node), {
      method: 'GET',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;
    if (res.ok) {
      return { id: node.id, reachable: true, latencyMs };
    }
    return {
      id: node.id,
      reachable: false,
      latencyMs,
      error: `HTTP ${res.status}`,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: node.id,
      reachable: false,
      latencyMs,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface HealthAllOptions {
  /** Override the fleet being probed (defaults to config.nodes). */
  nodes?: NodeDefinition[];
  /** Per-node probe timeout (default 2000ms). */
  timeoutMs?: number;
  /** fetch implementation injection for tests. */
  fetch?: typeof fetch;
}

export async function healthAll(
  config: EmberSynthConfig,
  opts: HealthAllOptions = {},
): Promise<HealthReport> {
  const nodes = opts.nodes ?? config.nodes.filter((n) => n.enabled);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetch ?? fetch;

  const probes = await Promise.all(
    nodes.map((n) => probeNode(n, timeoutMs, fetchImpl)),
  );

  let worst: HealthReport['worst'] = 'ok';
  if (probes.length === 0) {
    worst = 'ok';
  } else {
    const down = probes.filter((p) => !p.reachable).length;
    if (down === probes.length) worst = 'down';
    else if (down > 0) worst = 'degraded';
  }

  return { nodes: probes, worst };
}

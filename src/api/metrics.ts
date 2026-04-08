import type { EmberSynthConfig } from '../types/index.js';
import type { NodeRegistry } from '../registry/registry.js';

export interface MetricsSnapshot {
  service: string;
  version: string;
  uptime_ms: number;
  nodes: {
    total: number;
    enabled: number;
    healthy: number;
    degraded: number;
    unhealthy: number;
    unknown: number;
  };
  node_details: {
    id: string;
    label: string;
    enabled: boolean;
    capabilities: string[];
    health: string;
    latency_ms?: number;
    consecutive_failures: number;
    last_check?: string;
  }[];
  profiles: {
    id: string;
    label: string;
  }[];
  synthetic_models: string[];
}

const startTime = Date.now();

export function handleMetrics(config: EmberSynthConfig, registry: NodeRegistry): Response {
  const allNodes = registry.getAll();
  const allHealth = registry.getAllHealth();

  const healthCounts = { healthy: 0, degraded: 0, unhealthy: 0, unknown: 0 };
  for (const h of allHealth) {
    healthCounts[h.state]++;
  }

  const nodeDetails = allNodes.map((node) => {
    const h = registry.getHealth(node.id);
    return {
      id: node.id,
      label: node.label,
      enabled: node.enabled,
      capabilities: [...node.capabilities],
      health: h?.state ?? 'unknown',
      latency_ms: h?.latencyMs,
      consecutive_failures: h?.consecutiveFailures ?? 0,
      last_check: h?.lastCheck ? new Date(h.lastCheck).toISOString() : undefined,
    };
  });

  const snapshot: MetricsSnapshot = {
    service: 'embersynth',
    version: '0.2.0',
    uptime_ms: Date.now() - startTime,
    nodes: {
      total: allNodes.length,
      enabled: registry.getEnabled().length,
      ...healthCounts,
    },
    node_details: nodeDetails,
    profiles: config.profiles.map((p) => ({ id: p.id, label: p.label })),
    synthetic_models: Object.keys(config.syntheticModels),
  };

  return Response.json(snapshot);
}

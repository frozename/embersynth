import type { EmberSynthConfig } from '../types/index.js';
import type { NodeRegistry } from '../registry/registry.js';
import { getAdapter } from '../adapters/index.js';

/** Periodically check health of all enabled nodes */
export class HealthMonitor {
  private intervals: ReturnType<typeof setInterval>[] = [];
  private running = false;

  constructor(
    private config: EmberSynthConfig,
    private registry: NodeRegistry,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    // Run an initial check immediately
    this.checkAll();

    // Set up periodic checks per node
    for (const node of this.registry.getEnabled()) {
      const intervalMs = node.health.intervalMs ?? 30_000;
      const interval = setInterval(() => this.checkNode(node.id), intervalMs);
      this.intervals.push(interval);
    }
  }

  stop(): void {
    this.running = false;
    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.intervals = [];
  }

  async checkAll(): Promise<void> {
    const nodes = this.registry.getEnabled();
    await Promise.allSettled(nodes.map((n) => this.checkNode(n.id)));
  }

  async checkNode(nodeId: string): Promise<void> {
    const node = this.registry.getById(nodeId);
    if (!node || !node.enabled) return;

    const adapter = getAdapter(node.providerType);
    if (!adapter) return;

    try {
      const status = await adapter.checkHealth(node);
      this.registry.updateHealth(
        nodeId,
        status.state,
        status.latencyMs,
        status.error,
      );
    } catch (err) {
      this.registry.updateHealth(
        nodeId,
        'unhealthy',
        undefined,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

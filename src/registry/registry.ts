import type {
  NodeDefinition,
  Capability,
  HealthStatus,
  HealthState,
  RoutingProfile,
} from '../types/index.js';

export class NodeRegistry {
  private nodes: Map<string, NodeDefinition> = new Map();
  private health: Map<string, HealthStatus> = new Map();

  load(nodes: NodeDefinition[]): void {
    this.nodes.clear();
    // Prune health entries for nodes no longer in config
    const newIds = new Set(nodes.map((n) => n.id));
    for (const id of this.health.keys()) {
      if (!newIds.has(id)) this.health.delete(id);
    }
    for (const node of nodes) {
      this.nodes.set(node.id, node);
      // Initialize health as unknown
      if (!this.health.has(node.id)) {
        this.health.set(node.id, {
          nodeId: node.id,
          state: 'unknown',
          consecutiveFailures: 0,
        });
      }
    }
  }

  getAll(): NodeDefinition[] {
    return Array.from(this.nodes.values());
  }

  snapshotHealth(): Map<string, HealthStatus> {
    return new Map(this.health);
  }

  restoreHealth(snapshot: Map<string, HealthStatus>): void {
    this.health = snapshot;
  }

  getEnabled(): NodeDefinition[] {
    return this.getAll().filter((n) => n.enabled);
  }

  getById(id: string): NodeDefinition | undefined {
    return this.nodes.get(id);
  }

  /** Find enabled nodes that have ALL of the required capabilities */
  findByCapabilities(required: Capability[]): NodeDefinition[] {
    return this.getEnabled().filter((node) =>
      required.every((cap) => node.capabilities.includes(cap)),
    );
  }

  /** Find enabled nodes that have ANY of the given capabilities */
  findByAnyCapability(capabilities: Capability[]): NodeDefinition[] {
    return this.getEnabled().filter((node) =>
      capabilities.some((cap) => node.capabilities.includes(cap)),
    );
  }

  /** Filter nodes by tags (all required tags must be present, no excluded tags) */
  filterByTags(
    nodes: NodeDefinition[],
    requiredTags?: string[],
    excludedTags?: string[],
  ): NodeDefinition[] {
    return nodes.filter((node) => {
      if (requiredTags?.length) {
        if (!requiredTags.every((t) => node.tags.includes(t))) return false;
      }
      if (excludedTags?.length) {
        if (excludedTags.some((t) => node.tags.includes(t))) return false;
      }
      return true;
    });
  }

  /** Filter to only healthy (or optionally degraded) nodes */
  filterByHealth(
    nodes: NodeDefinition[],
    allowDegraded = false,
  ): NodeDefinition[] {
    return nodes.filter((node) => {
      const h = this.health.get(node.id);
      // Allow 'unknown' state through — this enables traffic during cold-start before
      // the first health probe completes. Nodes transition to healthy/degraded/unhealthy
      // after the first probe. Blocking unknown would prevent all traffic on fresh startup.
      if (!h) return true;
      if (h.state === 'healthy') return true;
      if (h.state === 'unknown') return true;
      if (allowDegraded && h.state === 'degraded') return true;
      return false;
    });
  }

  /** Sort nodes by priority (lower number = higher priority) */
  sortByPriority(nodes: NodeDefinition[]): NodeDefinition[] {
    return [...nodes].sort((a, b) => a.priority - b.priority);
  }

  /** Apply profile-based constraints (priority inversion, latency limits, capability boosting) */
  applyProfileConstraints(nodes: NodeDefinition[], profile: RoutingProfile): NodeDefinition[] {
    let candidates = [...nodes];

    // Filter out nodes whose last known latency exceeds the limit
    if (profile.maxLatencyMs != null) {
      candidates = candidates.filter((n) => {
        const h = this.getHealth(n.id);
        return h?.latencyMs == null || h.latencyMs <= profile.maxLatencyMs!;
      });
    }

    // Sort by preferred capabilities (if any), with priority as tie-break
    // When preferLowerPriority is false, higher priority numbers win
    const priorityDir = profile.preferLowerPriority === false ? -1 : 1;

    if (profile.preferredCapabilities?.length) {
      const prefs = profile.preferredCapabilities;
      candidates.sort((a, b) => {
        const aScore = prefs.filter((c: Capability) => a.capabilities.includes(c)).length;
        const bScore = prefs.filter((c: Capability) => b.capabilities.includes(c)).length;
        return (bScore - aScore) || (priorityDir * (a.priority - b.priority));
      });
    } else if (profile.preferLowerPriority === false) {
      candidates.reverse();
    }

    return candidates;
  }

  // ── Health management ──

  updateHealth(nodeId: string, state: HealthState, latencyMs?: number, error?: string): void {
    const existing = this.health.get(nodeId);
    const now = Date.now();

    const consecutiveFailures =
      state === 'healthy' ? 0 : (existing?.consecutiveFailures ?? 0) + 1;

    // Apply unhealthyAfter threshold: keep node as 'degraded' until
    // consecutive failures reach the configured threshold.
    let effectiveState = state;
    if (state === 'unhealthy') {
      const node = this.nodes.get(nodeId);
      const threshold = node?.health?.unhealthyAfter ?? 3;
      if (consecutiveFailures < threshold) {
        effectiveState = 'degraded';
      }
    }

    this.health.set(nodeId, {
      nodeId,
      state: effectiveState,
      lastCheck: now,
      lastSuccess: state === 'healthy' ? now : existing?.lastSuccess,
      consecutiveFailures,
      latencyMs,
      error,
    });
  }

  getHealth(nodeId: string): HealthStatus | undefined {
    return this.health.get(nodeId);
  }

  getAllHealth(): HealthStatus[] {
    return Array.from(this.health.values());
  }
}

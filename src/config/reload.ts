import { loadConfig } from './loader.js';
import type { NodeRegistry } from '../registry/registry.js';
import { HealthMonitor } from '../health/monitor.js';
import type { EmberSynthConfig } from '../types/index.js';
import { log } from '../logger/index.js';

/**
 * Single-shot config reload used by both the fs-watching ConfigWatcher
 * and the POST /config/reload HTTP endpoint. Re-reads the YAML from
 * disk, rebuilds the NodeRegistry, starts a fresh HealthMonitor, and
 * atomically swaps in the new state. On failure the original registry
 * + health snapshot are restored — the server keeps serving with the
 * last good config.
 *
 * Returns a diff suitable for operator audit: nodes added/removed
 * between the snapshot before and the one after.
 */

export interface ReloadResult {
  ok: boolean;
  configPath?: string;
  nodesBefore: number;
  nodesAfter: number;
  profilesBefore: number;
  profilesAfter: number;
  added: string[];
  removed: string[];
  error?: string;
}

export interface ReloadContext {
  configPath: string;
  config: EmberSynthConfig;
  registry: NodeRegistry;
  monitorRef: { current: HealthMonitor };
}

export function reloadConfigFromDisk(ctx: ReloadContext): ReloadResult {
  const before = {
    nodes: ctx.registry.getAll().length,
    profiles: ctx.config.profiles.length,
    nodeIds: new Set(ctx.registry.getAll().map((n) => n.id)),
  };
  const healthSnapshot = ctx.registry.snapshotHealth();
  const oldNodes = [...ctx.registry.getAll()];

  let newConfig: EmberSynthConfig;
  try {
    newConfig = loadConfig(ctx.configPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('config reload: load failed', { error: message });
    return {
      ok: false,
      configPath: ctx.configPath,
      nodesBefore: before.nodes,
      nodesAfter: before.nodes,
      profilesBefore: before.profiles,
      profilesAfter: before.profiles,
      added: [],
      removed: [],
      error: message,
    };
  }

  try {
    ctx.registry.load(newConfig.nodes);
    const newMonitor = new HealthMonitor(newConfig, ctx.registry);
    // Success path — swap monitor + config together.
    Object.assign(ctx.config, newConfig);
    ctx.monitorRef.current.stop();
    ctx.monitorRef.current = newMonitor;
    ctx.monitorRef.current.start();
  } catch (err) {
    // Roll back to the previous state so the server stays serving.
    ctx.registry.load(oldNodes);
    ctx.registry.restoreHealth(healthSnapshot);
    const message = err instanceof Error ? err.message : String(err);
    log.error('config reload: swap failed, rolled back', { error: message });
    return {
      ok: false,
      configPath: ctx.configPath,
      nodesBefore: before.nodes,
      nodesAfter: before.nodes,
      profilesBefore: before.profiles,
      profilesAfter: before.profiles,
      added: [],
      removed: [],
      error: message,
    };
  }

  const afterIds = new Set(ctx.registry.getAll().map((n) => n.id));
  const added: string[] = [];
  const removed: string[] = [];
  for (const id of afterIds) if (!before.nodeIds.has(id)) added.push(id);
  for (const id of before.nodeIds) if (!afterIds.has(id)) removed.push(id);
  log.info('config reloaded', {
    configPath: ctx.configPath,
    nodes: newConfig.nodes.length,
    profiles: newConfig.profiles.length,
    added: added.length,
    removed: removed.length,
  });
  return {
    ok: true,
    configPath: ctx.configPath,
    nodesBefore: before.nodes,
    nodesAfter: ctx.registry.getAll().length,
    profilesBefore: before.profiles,
    profilesAfter: newConfig.profiles.length,
    added,
    removed,
  };
}

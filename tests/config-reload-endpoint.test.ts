import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { loadConfig } from '../src/config/loader.js';
import { reloadConfigFromDisk } from '../src/config/reload.js';
import { NodeRegistry } from '../src/registry/registry.js';
import { HealthMonitor } from '../src/health/monitor.js';
import { createServer } from '../src/api/server.js';

/**
 * K.7.3b — embersynth POST /config/reload. Exercises the endpoint
 * + the underlying reloadConfigFromDisk helper end-to-end against a
 * real Bun.serve instance.
 */

let runtimeDir = '';
let configPath = '';
const originalEnv = { ...process.env };

function writeConfig(nodes: Array<{ id: string; enabled?: boolean }>): void {
  writeFileSync(
    configPath,
    stringifyYaml({
      server: { host: '127.0.0.1', port: 0 },
      nodes: nodes.map((n) => ({
        id: n.id,
        label: n.id,
        endpoint: 'http://127.0.0.1:65535/v1',
        transport: 'http',
        enabled: n.enabled ?? true,
        capabilities: ['reasoning'],
        tags: [],
        providerType: 'openai-compatible',
        modelId: 'm1',
        priority: 1,
        auth: { type: 'none' },
        health: { endpoint: '/health', timeoutMs: 100, intervalSeconds: 60 },
      })),
      profiles: [],
      syntheticModels: { 'fusion-auto': 'auto' },
    }),
  );
}

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'embersynth-reload-'));
  configPath = join(runtimeDir, 'embersynth.yaml');
  writeConfig([{ id: 'node-a' }, { id: 'node-b' }]);
});

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

describe('reloadConfigFromDisk', () => {
  test('reports added + removed node ids after a config edit', () => {
    const config = loadConfig(configPath);
    const registry = new NodeRegistry();
    registry.load(config.nodes);
    const monitor = new HealthMonitor(config, registry);
    const monitorRef = { current: monitor };
    expect(registry.getAll().map((n) => n.id).sort()).toEqual(['node-a', 'node-b']);

    // Edit: remove node-b, add node-c.
    writeConfig([{ id: 'node-a' }, { id: 'node-c' }]);

    const result = reloadConfigFromDisk({
      configPath,
      config,
      registry,
      monitorRef,
    });
    expect(result.ok).toBe(true);
    expect(result.added.sort()).toEqual(['node-c']);
    expect(result.removed.sort()).toEqual(['node-b']);
    expect(result.nodesBefore).toBe(2);
    expect(result.nodesAfter).toBe(2);
    expect(registry.getAll().map((n) => n.id).sort()).toEqual(['node-a', 'node-c']);
    monitorRef.current.stop();
  });

  test('malformed config returns ok=false and keeps current state', () => {
    const config = loadConfig(configPath);
    const registry = new NodeRegistry();
    registry.load(config.nodes);
    const monitor = new HealthMonitor(config, registry);
    const monitorRef = { current: monitor };

    // Truncate to produce invalid YAML.
    writeFileSync(configPath, ': this is not valid yaml ::');

    const result = reloadConfigFromDisk({
      configPath,
      config,
      registry,
      monitorRef,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // Registry unchanged.
    expect(registry.getAll().map((n) => n.id).sort()).toEqual(['node-a', 'node-b']);
    monitorRef.current.stop();
  });
});

describe('POST /config/reload endpoint', () => {
  test('returns 200 + diff after a successful reload', async () => {
    const config = loadConfig(configPath);
    const registry = new NodeRegistry();
    registry.load(config.nodes);
    const monitor = new HealthMonitor(config, registry);
    const monitorRef = { current: monitor };
    const server = createServer(config, registry, {
      onReload: () =>
        reloadConfigFromDisk({
          configPath,
          config,
          registry,
          monitorRef,
        }),
    });
    try {
      writeConfig([{ id: 'node-a' }]); // remove node-b
      const res = await fetch(`http://127.0.0.1:${server.port}/config/reload`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        added: string[];
        removed: string[];
      };
      expect(body.ok).toBe(true);
      expect(body.removed).toEqual(['node-b']);
      expect(body.added).toEqual([]);
    } finally {
      server.stop(true);
      monitorRef.current.stop();
    }
  });

  test('returns 503 when reload is not wired', async () => {
    const config = loadConfig(configPath);
    const registry = new NodeRegistry();
    registry.load(config.nodes);
    const server = createServer(config, registry);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/config/reload`, {
        method: 'POST',
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

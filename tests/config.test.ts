import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveProfileFromModel } from '../src/config/loader.js';

describe('config loading', () => {
  test('returns default config when no file exists', () => {
    const config = loadConfig();
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.port).toBe(7777);
    expect(config.nodes).toEqual([]);
    expect(config.profiles.length).toBeGreaterThan(0);
  });

  test('throws when explicit config path does not exist', () => {
    expect(() => loadConfig('./nonexistent.yaml')).toThrow(
      'Config file not found: ./nonexistent.yaml',
    );
  });

  test('loads example config file', () => {
    const config = loadConfig('./config/embersynth.example.yaml');
    expect(config.nodes.length).toBeGreaterThan(0);
    expect(config.nodes[0].id).toBe('reasoning-primary');
    expect(config.nodes[0].capabilities).toContain('reasoning');
    expect(config.nodes[0].enabled).toBe(true);
  });

  test('normalizes node defaults', () => {
    const config = loadConfig('./config/examples/single-node.yaml');
    const node = config.nodes[0];
    expect(node.auth.type).toBe('none');
    expect(node.health.endpoint).toBe('/health');
    expect(node.transport).toBe('http');
    expect(node.priority).toBe(1);
    expect(node.providerType).toBe('openai-compatible');
  });

  test('preserves synthetic model mappings', () => {
    const config = loadConfig();
    expect(config.syntheticModels['fusion-auto']).toBe('auto');
    expect(config.syntheticModels['fusion-fast']).toBe('fast');
    expect(config.syntheticModels['fusion-private']).toBe('private');
    expect(config.syntheticModels['fusion-vision']).toBe('vision');
  });

  test('env var override for server host/port', () => {
    const origHost = process.env.EMBERSYNTH_HOST;
    const origPort = process.env.EMBERSYNTH_PORT;
    try {
      process.env.EMBERSYNTH_HOST = '0.0.0.0';
      process.env.EMBERSYNTH_PORT = '9999';
      const config = loadConfig();
      expect(config.server.host).toBe('0.0.0.0');
      expect(config.server.port).toBe(9999);
    } finally {
      if (origHost !== undefined) process.env.EMBERSYNTH_HOST = origHost;
      else delete process.env.EMBERSYNTH_HOST;
      if (origPort !== undefined) process.env.EMBERSYNTH_PORT = origPort;
      else delete process.env.EMBERSYNTH_PORT;
    }
  });
});

describe('profile resolution', () => {
  test('resolves synthetic model to profile', () => {
    const config = loadConfig();
    const profile = resolveProfileFromModel('fusion-auto', config);
    expect(profile).not.toBeNull();
    expect(profile!.id).toBe('auto');
  });

  test('returns null for unknown model', () => {
    const config = loadConfig();
    const profile = resolveProfileFromModel('unknown-model', config);
    expect(profile).toBeNull();
  });

  test('fusion-private profile requires private tag', () => {
    const config = loadConfig();
    const profile = resolveProfileFromModel('fusion-private', config);
    expect(profile).not.toBeNull();
    expect(profile!.requiredTags).toContain('private');
  });

  test('fusion-fast profile limits stages', () => {
    const config = loadConfig();
    const profile = resolveProfileFromModel('fusion-fast', config);
    expect(profile).not.toBeNull();
    expect(profile!.maxStages).toBe(1);
  });
});

describe('server.watch and server.logLevel from the YAML file (#13)', () => {
  let tempDir = '';

  afterEach(() => {
    if (tempDir !== '') {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  function writeConfig(body: string): string {
    tempDir = mkdtempSync(join(tmpdir(), 'es-config-13-'));
    const configPath = join(tempDir, 'embersynth.yaml');
    writeFileSync(configPath, body);
    return configPath;
  }

  test('keeps server.watch: true and server.logLevel: debug', () => {
    const configPath = writeConfig('server:\n  host: 127.0.0.1\n  port: 7777\n  watch: true\n  logLevel: debug\n');
    const config = loadConfig(configPath);
    expect(config.server.watch).toBe(true);
    expect(config.server.logLevel).toBe('debug');
  });

  test('leaves watch and logLevel absent when the keys are not set', () => {
    const configPath = writeConfig('server:\n  host: 127.0.0.1\n  port: 7777\n');
    const config = loadConfig(configPath);
    expect(config.server.watch).toBeUndefined();
    expect(config.server.logLevel).toBeUndefined();
    expect(Object.keys(config.server).sort()).toEqual(['host', 'port']);
  });

  test('accepts watch as the string true produced by env interpolation', () => {
    const previous = process.env.ES13_UNSET_WATCH;
    try {
      Reflect.deleteProperty(process.env, 'ES13_UNSET_WATCH');
      const configPath = writeConfig('server:\n  watch: "${ES13_UNSET_WATCH:-true}"\n');
      const config = loadConfig(configPath);
      expect(config.server.watch).toBe(true);
    } finally {
      if (previous !== undefined) process.env.ES13_UNSET_WATCH = previous;
      else Reflect.deleteProperty(process.env, 'ES13_UNSET_WATCH');
    }
  });

  test('does not turn watch: "false" or a non-string logLevel into a value', () => {
    const configPath = writeConfig('server:\n  watch: "false"\n  logLevel: 42\n');
    const config = loadConfig(configPath);
    expect(config.server.watch).toBeUndefined();
    expect(config.server.logLevel).toBeUndefined();
  });
});

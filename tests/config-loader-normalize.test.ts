import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveConfigPath } from '../src/config/loader.js';
import type { EmberSynthConfig } from '../src/types/index.js';

// #22: pin env interpolation, the num() fallback, node defaults, duplicate
// node ids and the default merges of src/config/loader.ts.

let tempDir = '';

afterEach(() => {
  if (tempDir !== '') {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

/** Write `body` to <tempDir>/embersynth.yaml (one temp dir per test) and return the path. */
function writeConfig(body: string): string {
  if (tempDir === '') tempDir = mkdtempSync(join(tmpdir(), 'es-config-22-'));
  const configPath = join(tempDir, 'embersynth.yaml');
  writeFileSync(configPath, body);
  return configPath;
}

/** Run `fn` with each named env var set (or deleted when undefined), then restore them all. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const name of Object.keys(vars)) previous[name] = process.env[name];
  try {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    return fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}

/** loadConfig(configPath) with EMBERSYNTH_HOST/EMBERSYNTH_PORT unset unless `vars` sets them. */
function loadWith(configPath: string, vars: Record<string, string | undefined> = {}): EmberSynthConfig {
  return withEnv({ EMBERSYNTH_HOST: undefined, EMBERSYNTH_PORT: undefined, ...vars }, () => loadConfig(configPath));
}

describe('config loader: env interpolation (#22)', () => {
  test('a set variable wins over its fallback', () => {
    const config = loadWith(writeConfig('nodes:\n  - id: "${ES_PIN_SET:-fb}"\n'), { ES_PIN_SET: 'real' });
    expect(config.nodes[0].id).toBe('real');
  });

  test('an unset variable uses its trimmed fallback', () => {
    const config = loadWith(writeConfig('nodes:\n  - id: a\n    label: "${ES_PIN_UNSET:- fb }"\n'), { ES_PIN_UNSET: undefined });
    expect(config.nodes[0].label).toBe('fb');
  });

  test('an unset variable without a fallback becomes an empty string', () => {
    const config = loadWith(writeConfig('nodes:\n  - id: a\n    label: "x${ES_PIN_UNSET}y"\n'), { ES_PIN_UNSET: undefined });
    expect(config.nodes[0].label).toBe('xy');
  });

  test('every reference in one string is replaced', () => {
    const config = loadWith(
      writeConfig('nodes:\n  - id: a\n    endpoint: "http://${ES_PIN_H:-localhost}:${ES_PIN_P:-9000}"\n'),
      { ES_PIN_H: undefined, ES_PIN_P: undefined },
    );
    expect(config.nodes[0].endpoint).toBe('http://localhost:9000');
  });

  test('strings inside arrays and nested objects are interpolated', () => {
    const config = loadWith(
      writeConfig(
        'nodes:\n  - id: a\n    tags: ["${ES_PIN_TAG:-private}", fixed]\n    health:\n      endpoint: "${ES_PIN_UNSET:-/hz}"\n',
      ),
      { ES_PIN_TAG: 'gpu', ES_PIN_UNSET: undefined },
    );
    expect(config.nodes[0].tags).toEqual(['gpu', 'fixed']);
    expect(config.nodes[0].health.endpoint).toBe('/hz');
  });
});

describe('config loader: numeric fallback (#22)', () => {
  test('priority: 0 is kept, and a missing priority defaults to 10', () => {
    const config = loadWith(writeConfig('nodes:\n  - id: zero\n    priority: 0\n  - id: unset\n'));
    expect(config.nodes[0].priority).toBe(0);
    expect(config.nodes[1].priority).toBe(10);
  });

  test('an empty or non-numeric value falls back to the default', () => {
    const config = loadWith(
      writeConfig(
        'nodes:\n  - id: a\n    health:\n      intervalMs: ""\n      timeoutMs: abc\n      unhealthyAfter: "${ES_PIN_UNSET}"\n',
      ),
      { ES_PIN_UNSET: undefined },
    );
    expect(config.nodes[0].health.intervalMs).toBe(30_000);
    expect(config.nodes[0].health.timeoutMs).toBe(5_000);
    expect(config.nodes[0].health.unhealthyAfter).toBe(3);
  });

  test('a numeric string from interpolation becomes a number', () => {
    const config = loadWith(writeConfig('nodes:\n  - id: a\n    timeout:\n      requestMs: "${ES_PIN_UNSET:-2500}"\n'), {
      ES_PIN_UNSET: undefined,
    });
    expect(config.nodes[0].timeout.requestMs).toBe(2500);
    expect(config.nodes[0].timeout.connectMs).toBe(5_000);
  });

  test('EMBERSYNTH_PORT overrides server.port, and a non-numeric value gives 7777', () => {
    const configPath = writeConfig('server:\n  port: 8123\n');
    expect(loadWith(configPath).server.port).toBe(8123);
    expect(loadWith(configPath, { EMBERSYNTH_PORT: '9100' }).server.port).toBe(9100);
    expect(loadWith(configPath, { EMBERSYNTH_PORT: 'abc' }).server.port).toBe(7777);
  });
});

describe('config loader: node defaults (#22)', () => {
  test('a node without id or label gets index-based names and the documented defaults', () => {
    const config = loadWith(writeConfig('nodes:\n  - id: first\n  - endpoint: "http://pin-host:8080"\n'));
    expect(config.nodes[1]).toEqual({
      id: 'node-1',
      label: 'Node 1',
      endpoint: 'http://pin-host:8080',
      transport: 'http',
      enabled: true,
      capabilities: [],
      tags: [],
      auth: { type: 'none' },
      health: { endpoint: '/health', intervalMs: 30_000, timeoutMs: 5_000, unhealthyAfter: 3 },
      timeout: { requestMs: 120_000, connectMs: 5_000 },
      priority: 10,
      providerType: 'openai-compatible',
    });
    expect(config.nodes[0].endpoint).toBe('http://localhost:8080');
    expect(config.nodes[0].label).toBe('Node 0');
  });

  test('enabled is false only for the boolean false', () => {
    const config = loadWith(
      writeConfig('nodes:\n  - id: a\n    enabled: false\n  - id: b\n    enabled: "false"\n  - id: c\n    enabled: 0\n'),
    );
    expect(config.nodes.map((n) => n.enabled)).toEqual([false, true, true]);
  });

  test('a non-object auth becomes type none and an object auth keeps its type', () => {
    const config = loadWith(writeConfig('nodes:\n  - id: a\n    auth: bearer\n  - id: b\n    auth:\n      type: bearer\n'));
    expect(config.nodes[0].auth).toEqual({ type: 'none' });
    expect(config.nodes[1].auth.type).toBe('bearer');
  });
});

describe('config loader: duplicate node ids (#22)', () => {
  test('keeps the first definition of a duplicated id', () => {
    const config = loadWith(
      writeConfig(
        'nodes:\n  - id: dup\n    label: First\n    endpoint: "http://first:1"\n  - id: other\n  - id: dup\n    label: Second\n    endpoint: "http://second:2"\n',
      ),
    );
    expect(config.nodes.map((n) => n.id)).toEqual(['dup', 'other']);
    expect(config.nodes[0].label).toBe('First');
    expect(config.nodes[0].endpoint).toBe('http://first:1');
  });
});

describe('config loader: merges with the defaults (#22)', () => {
  test('YAML syntheticModels are merged over the built-in map', () => {
    const config = loadWith(writeConfig('syntheticModels:\n  my-model: fast\n  fusion-fast: auto\n'));
    expect(config.syntheticModels).toEqual({
      'fusion-auto': 'auto',
      'fusion-fast': 'auto',
      'fusion-private': 'private',
      'fusion-vision': 'vision',
      'my-model': 'fast',
    });
  });

  test('a partial YAML policy keeps the other default policy keys', () => {
    const config = loadWith(writeConfig('policy:\n  maxRetries: 5\n'));
    expect(config.policy).toEqual({
      fallbackEnabled: true,
      maxRetries: 5,
      retryDelayMs: 500,
      requireHealthy: true,
      evidenceCompression: false,
    });
  });
});

describe('config loader: resolveConfigPath (#22)', () => {
  test('returns an explicit path that exists and undefined for one that does not', () => {
    const configPath = writeConfig('server:\n  port: 7777\n');
    expect(resolveConfigPath(configPath)).toBe(configPath);
    expect(resolveConfigPath(join(tempDir, 'missing.yaml'))).toBeUndefined();
  });
});

describe('config loader: policy coercion (#34)', () => {
  test('interpolated policy strings become numbers and booleans', () => {
    const config = loadWith(
      writeConfig(
        'policy:\n  maxRetries: "${ES_PIN_RETRIES:-2}"\n  retryDelayMs: "${ES_PIN_DELAY:-10}"\n  requireHealthy: "${ES_PIN_RH:-false}"\n',
      ),
      { ES_PIN_RETRIES: undefined, ES_PIN_DELAY: undefined, ES_PIN_RH: undefined },
    );
    expect(config.policy.maxRetries).toBe(2);
    expect(config.policy.retryDelayMs).toBe(10);
    expect(config.policy.requireHealthy).toBe(false);
    expect(config.policy).toEqual({
      fallbackEnabled: true,
      maxRetries: 2,
      retryDelayMs: 10,
      requireHealthy: false,
      evidenceCompression: false,
    });
  });

  test('the strings "false" and "true" switch every boolean policy key', () => {
    const config = loadWith(
      writeConfig(
        'policy:\n  fallbackEnabled: "${ES_PIN_FB:-true}"\n  requireHealthy: "false"\n  evidenceCompression: "${ES_PIN_EC:-false}"\n',
      ),
      { ES_PIN_FB: 'false', ES_PIN_EC: 'true' },
    );
    expect(config.policy.fallbackEnabled).toBe(false);
    expect(config.policy.requireHealthy).toBe(false);
    expect(config.policy.evidenceCompression).toBe(true);
  });

  test('a non-numeric maxRetries falls back to 2 and an empty retryDelayMs to 500', () => {
    const config = loadWith(writeConfig('policy:\n  maxRetries: abc\n  retryDelayMs: ""\n'));
    expect(config.policy.maxRetries).toBe(2);
    expect(config.policy.retryDelayMs).toBe(500);
  });

  test('maxRetries is clamped to a non-negative integer and a non-finite value gives 2', () => {
    expect(loadWith(writeConfig('policy:\n  maxRetries: -3\n')).policy.maxRetries).toBe(0);
    expect(loadWith(writeConfig('policy:\n  maxRetries: "1.7"\n')).policy.maxRetries).toBe(1);
    expect(loadWith(writeConfig('policy:\n  maxRetries: "Infinity"\n')).policy.maxRetries).toBe(2);
  });

  test('a value that is not a boolean or "true"/"false" keeps the default', () => {
    const config = loadWith(
      writeConfig('policy:\n  requireHealthy: 0\n  fallbackEnabled: "no"\n  evidenceCompression: "yes"\n'),
    );
    expect(config.policy.requireHealthy).toBe(true);
    expect(config.policy.fallbackEnabled).toBe(true);
    expect(config.policy.evidenceCompression).toBe(false);
  });

  test('evidenceMaxLength is coerced when numeric and left absent otherwise', () => {
    const coerced = loadWith(writeConfig('policy:\n  evidenceMaxLength: "${ES_PIN_EML:-300}"\n'), {
      ES_PIN_EML: undefined,
    });
    expect(coerced.policy.evidenceMaxLength).toBe(300);
    const unset = loadWith(writeConfig('policy:\n  maxRetries: 1\n'));
    expect('evidenceMaxLength' in unset.policy).toBe(false);
    const invalid = loadWith(writeConfig('policy:\n  evidenceMaxLength: abc\n'));
    expect('evidenceMaxLength' in invalid.policy).toBe(false);
  });

  test('unknown policy keys are dropped and a null or scalar policy gives the defaults', () => {
    const defaults = {
      fallbackEnabled: true,
      maxRetries: 2,
      retryDelayMs: 500,
      requireHealthy: true,
      evidenceCompression: false,
    };
    expect(Object.keys(loadWith(writeConfig('policy:\n  maxRetries: 1\n  extra: 7\n')).policy).sort()).toEqual([
      'evidenceCompression',
      'fallbackEnabled',
      'maxRetries',
      'requireHealthy',
      'retryDelayMs',
    ]);
    expect(loadWith(writeConfig('policy:\n')).policy).toEqual(defaults);
    expect(loadWith(writeConfig('policy: 5\n')).policy).toEqual(defaults);
  });
});

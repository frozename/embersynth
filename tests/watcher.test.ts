import { describe, test, expect, afterAll } from 'bun:test';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigWatcher } from '../src/config/watcher.js';

const VALID_CONFIG = `
server:
  host: 127.0.0.1
  port: 7777

nodes:
  - id: test-node
    label: Test Node
    endpoint: http://localhost:8080
    capabilities:
      - reasoning
    tags:
      - local

profiles:
  - id: auto
    label: Automatic
`;

const UPDATED_CONFIG = `
server:
  host: 127.0.0.1
  port: 7777

nodes:
  - id: test-node
    label: Test Node
    endpoint: http://localhost:8080
    capabilities:
      - reasoning
    tags:
      - local
  - id: second-node
    label: Second Node
    endpoint: http://localhost:8081
    capabilities:
      - vision
    tags:
      - local

profiles:
  - id: auto
    label: Automatic
`;

const INVALID_YAML = `
server:
  host: 127.0.0.1
  port: not_a_number
nodes: [[[invalid
`;

// Create a temp directory for all test files
const tmpDir = mkdtempSync(join(tmpdir(), 'embersynth-watcher-'));
const tempFiles: string[] = [];

function makeTempConfig(content: string): string {
  const path = join(tmpDir, `config-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(path, content);
  tempFiles.push(path);
  return path;
}

afterAll(() => {
  for (const f of tempFiles) {
    try { unlinkSync(f); } catch {}
  }
});

describe('ConfigWatcher', () => {
  test('calls onChange when file changes', async () => {
    const configPath = makeTempConfig(VALID_CONFIG);
    let callCount = 0;
    let receivedConfig: unknown = null;

    const watcher = new ConfigWatcher(configPath, (config) => {
      callCount++;
      receivedConfig = config;
    }, 50); // short debounce for faster test

    watcher.start();

    // Modify the file
    writeFileSync(configPath, UPDATED_CONFIG);

    // Wait for debounce + processing
    await new Promise((resolve) => setTimeout(resolve, 300));

    watcher.stop();

    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(receivedConfig).not.toBeNull();
    expect((receivedConfig as { nodes: unknown[] }).nodes.length).toBe(2);
  });

  test('debounces rapid changes', async () => {
    const configPath = makeTempConfig(VALID_CONFIG);
    let callCount = 0;

    const watcher = new ConfigWatcher(configPath, () => {
      callCount++;
    }, 100); // 100ms debounce

    watcher.start();

    // Fire 5 rapid changes
    for (let i = 0; i < 5; i++) {
      writeFileSync(configPath, VALID_CONFIG + `\n# change ${i}\n`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Wait for debounce to settle
    await new Promise((resolve) => setTimeout(resolve, 400));

    watcher.stop();

    // Should have debounced to 1 call (or at most 2 if a boundary was hit)
    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(callCount).toBeLessThanOrEqual(2);
  });

  test('survives invalid YAML without crashing', async () => {
    const configPath = makeTempConfig(VALID_CONFIG);
    let callCount = 0;

    const watcher = new ConfigWatcher(configPath, () => {
      callCount++;
    }, 50);

    watcher.start();

    // Write invalid yaml
    writeFileSync(configPath, INVALID_YAML);

    // Wait for debounce + processing
    await new Promise((resolve) => setTimeout(resolve, 300));

    watcher.stop();

    // onChange should NOT have been called since the config is invalid
    expect(callCount).toBe(0);
  });

  test('stop() prevents further callbacks', async () => {
    const configPath = makeTempConfig(VALID_CONFIG);
    let callCount = 0;

    const watcher = new ConfigWatcher(configPath, () => {
      callCount++;
    }, 50);

    watcher.start();
    watcher.stop();

    // Modify file after stop
    writeFileSync(configPath, UPDATED_CONFIG);

    // Wait well beyond debounce
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(callCount).toBe(0);
  });
});

import { describe, test, expect } from 'bun:test';
import { loadConfig } from '../src/config/loader.js';

describe('CLI config validation logic', () => {
  test('detects duplicate node IDs', () => {
    // Simulate the check-config logic
    const config = loadConfig('./config/embersynth.example.yaml');
    const nodeIds = new Set<string>();
    const duplicates: string[] = [];

    for (const node of config.nodes) {
      if (nodeIds.has(node.id)) {
        duplicates.push(node.id);
      }
      nodeIds.add(node.id);
    }

    expect(duplicates.length).toBe(0);
  });

  test('detects nodes with no capabilities', () => {
    const config = loadConfig('./config/embersynth.example.yaml');
    const noCapabilities = config.nodes.filter((n) => n.capabilities.length === 0);
    expect(noCapabilities.length).toBe(0);
  });

  test('all synthetic models map to existing profiles', () => {
    const config = loadConfig('./config/embersynth.example.yaml');
    const profileIds = new Set(config.profiles.map((p) => p.id));

    for (const [model, profileId] of Object.entries(config.syntheticModels)) {
      expect(profileIds.has(profileId)).toBe(true);
    }
  });

  test('config has at least one reasoning-capable node', () => {
    const config = loadConfig('./config/embersynth.example.yaml');
    const reasoningNodes = config.nodes.filter((n) =>
      n.enabled && n.capabilities.includes('reasoning'),
    );
    expect(reasoningNodes.length).toBeGreaterThan(0);
  });
});

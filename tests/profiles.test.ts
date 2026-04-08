import { describe, test, expect } from 'bun:test';
import { SYNTHETIC_MODEL_MAP, DEFAULT_PROFILES } from '../src/config/defaults.js';

describe('synthetic model mapping', () => {
  test('all synthetic models map to existing profiles', () => {
    const profileIds = DEFAULT_PROFILES.map((p) => p.id);

    for (const [modelId, profileId] of Object.entries(SYNTHETIC_MODEL_MAP)) {
      expect(profileIds).toContain(profileId);
    }
  });

  test('fusion-auto maps to auto', () => {
    expect(SYNTHETIC_MODEL_MAP['fusion-auto']).toBe('auto');
  });

  test('fusion-fast maps to fast', () => {
    expect(SYNTHETIC_MODEL_MAP['fusion-fast']).toBe('fast');
  });

  test('fusion-private maps to private', () => {
    expect(SYNTHETIC_MODEL_MAP['fusion-private']).toBe('private');
  });

  test('fusion-vision maps to vision', () => {
    expect(SYNTHETIC_MODEL_MAP['fusion-vision']).toBe('vision');
  });
});

describe('profile properties', () => {
  const getProfile = (id: string) => DEFAULT_PROFILES.find((p) => p.id === id)!;

  test('auto profile has no restrictive constraints', () => {
    const p = getProfile('auto');
    expect(p.requiredTags).toBeUndefined();
    expect(p.maxStages).toBeUndefined();
  });

  test('fast profile constrains stages', () => {
    const p = getProfile('fast');
    expect(p.maxStages).toBe(1);
  });

  test('private profile requires private tag', () => {
    const p = getProfile('private');
    expect(p.requiredTags).toContain('private');
  });

  test('vision profile enables synthesis', () => {
    const p = getProfile('vision');
    expect(p.synthesisRequired).toBe(true);
    expect(p.preferredCapabilities).toContain('vision');
  });
});

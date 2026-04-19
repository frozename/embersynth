import type { EmberSynthConfig, RoutingPolicy, RoutingProfile } from '../types/index.js';

export const DEFAULT_POLICY: RoutingPolicy = {
  fallbackEnabled: true,
  maxRetries: 2,
  retryDelayMs: 500,
  requireHealthy: true,
  evidenceCompression: false,
};

export const DEFAULT_PROFILES: RoutingProfile[] = [
  {
    id: 'auto',
    label: 'Automatic',
    description: 'Balanced routing with automatic capability selection',
    allowDegradedNodes: false,
    preferLowerPriority: true,
  },
  {
    id: 'fast',
    label: 'Fast',
    description: 'Prefer lowest latency nodes, minimize stages',
    maxStages: 1,
    preferLowerPriority: true,
    allowDegradedNodes: false,
  },
  {
    id: 'private',
    label: 'Private',
    description: 'Only use nodes tagged as private or local',
    requiredTags: ['private'],
    allowDegradedNodes: false,
  },
  {
    id: 'vision',
    label: 'Vision',
    description: 'Prefer vision-capable nodes with synthesis',
    preferredCapabilities: ['vision'],
    synthesisRequired: true,
    allowDegradedNodes: false,
  },
];

export const SYNTHETIC_MODEL_MAP: Record<string, string> = {
  'fusion-auto': 'auto',
  'fusion-fast': 'fast',
  'fusion-private': 'private',
  'fusion-vision': 'vision',
};

export const DEFAULT_CONFIG: EmberSynthConfig = {
  server: {
    host: '127.0.0.1',
    port: 7777,
  },
  nodes: [],
  profiles: DEFAULT_PROFILES,
  policy: DEFAULT_POLICY,
  syntheticModels: SYNTHETIC_MODEL_MAP,
};

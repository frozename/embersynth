import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CONFIG, DEFAULT_POLICY, DEFAULT_PROFILES, SYNTHETIC_MODEL_MAP } from './defaults.js';
import type { EmberSynthConfig, NodeDefinition, NodeAuth, RoutingProfile } from '../types/index.js';

const CONFIG_PATHS = [
  './embersynth.yaml',
  './embersynth.yml',
  './config/embersynth.yaml',
  './config/embersynth.yml',
];

/** Resolve env var references like ${VAR_NAME} or ${VAR_NAME:-default} */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const [name, fallback] = expr.split(':-');
    return process.env[name.trim()] ?? fallback?.trim() ?? '';
  });
}

/** Deep-walk an object and interpolate all string values */
function interpolateDeep<T>(obj: T): T {
  if (typeof obj === 'string') return interpolateEnv(obj) as T;
  if (Array.isArray(obj)) return obj.map(interpolateDeep) as T;
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = interpolateDeep(v);
    }
    return result as T;
  }
  return obj;
}

function normalizeAuth(raw: unknown): NodeAuth {
  if (!raw || typeof raw !== 'object') return { type: 'none' };
  const auth = raw as Record<string, unknown>;
  return {
    type: (auth.type as NodeAuth['type']) ?? 'none',
    token: auth.token as string | undefined,
    headerName: auth.headerName as string | undefined,
    headerValue: auth.headerValue as string | undefined,
  };
}

function normalizeNode(raw: Record<string, unknown>, index: number): NodeDefinition {
  return {
    id: (raw.id as string) ?? `node-${index}`,
    label: (raw.label as string) ?? `Node ${index}`,
    endpoint: (raw.endpoint as string) ?? 'http://localhost:8080',
    transport: (raw.transport as 'http' | 'https') ?? 'http',
    enabled: raw.enabled !== false,
    capabilities: ((raw.capabilities ?? []) as string[]) as NodeDefinition['capabilities'],
    tags: (raw.tags as string[]) ?? [],
    auth: normalizeAuth(raw.auth),
    health: {
      endpoint: (raw.health as Record<string, unknown>)?.endpoint as string ?? '/health',
      intervalMs: Number((raw.health as Record<string, unknown>)?.intervalMs) || 30_000,
      timeoutMs: Number((raw.health as Record<string, unknown>)?.timeoutMs) || 5_000,
      unhealthyAfter: Number((raw.health as Record<string, unknown>)?.unhealthyAfter) || 3,
    },
    timeout: {
      requestMs: Number((raw.timeout as Record<string, unknown>)?.requestMs) || 120_000,
      connectMs: Number((raw.timeout as Record<string, unknown>)?.connectMs) || 5_000,
    },
    priority: Number(raw.priority) || 10,
    modelId: raw.modelId as string | undefined,
    providerType: (raw.providerType as string) ?? 'openai-compatible',
    optimization: raw.optimization as NodeDefinition['optimization'],
  };
}

function normalizeProfile(raw: Record<string, unknown>): RoutingProfile {
  return {
    id: raw.id as string,
    label: (raw.label as string) ?? raw.id as string,
    description: raw.description as string | undefined,
    preferredCapabilities: raw.preferredCapabilities as RoutingProfile['preferredCapabilities'],
    requiredTags: raw.requiredTags as string[] | undefined,
    excludedTags: raw.excludedTags as string[] | undefined,
    maxLatencyMs: raw.maxLatencyMs as number | undefined,
    preferLowerPriority: raw.preferLowerPriority as boolean | undefined,
    allowDegradedNodes: raw.allowDegradedNodes as boolean | undefined,
    maxStages: raw.maxStages as number | undefined,
    synthesisRequired: raw.synthesisRequired as boolean | undefined,
  };
}

/** Return the first config file path that exists, or undefined */
export function resolveConfigPath(configPath?: string): string | undefined {
  if (configPath) return existsSync(configPath) ? configPath : undefined;
  return CONFIG_PATHS.find((p) => existsSync(p));
}

export function loadConfig(configPath?: string): EmberSynthConfig {
  if (configPath && !existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  let rawConfig: Record<string, unknown> | null = null;

  // Try explicit path first, then search defaults
  const paths = configPath ? [configPath] : CONFIG_PATHS;

  for (const p of paths) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8');
      rawConfig = interpolateDeep(parseYaml(content)) as Record<string, unknown>;
      break;
    }
  }

  // Apply env var overrides
  const envHost = process.env.EMBERSYNTH_HOST;
  const envPort = process.env.EMBERSYNTH_PORT;

  const serverRaw = (rawConfig?.server as Record<string, unknown>) ?? {};

  const config: EmberSynthConfig = {
    server: {
      host: envHost ?? (serverRaw.host as string) ?? DEFAULT_CONFIG.server.host,
      port: envPort ? parseInt(envPort, 10) : Number(serverRaw.port) || DEFAULT_CONFIG.server.port,
    },
    nodes: rawConfig?.nodes
      ? (rawConfig.nodes as Record<string, unknown>[]).map(normalizeNode)
      : DEFAULT_CONFIG.nodes,
    profiles: rawConfig?.profiles
      ? (rawConfig.profiles as Record<string, unknown>[]).map(normalizeProfile)
      : DEFAULT_PROFILES,
    policy: {
      ...DEFAULT_POLICY,
      ...((rawConfig?.policy as Partial<typeof DEFAULT_POLICY>) ?? {}),
    },
    syntheticModels: {
      ...SYNTHETIC_MODEL_MAP,
      ...((rawConfig?.syntheticModels as Record<string, string>) ?? {}),
    },
  };

  return config;
}

export function resolveProfileFromModel(
  modelId: string,
  config: EmberSynthConfig,
): RoutingProfile | null {
  const profileId = config.syntheticModels[modelId];
  if (!profileId) return null;
  return config.profiles.find((p) => p.id === profileId) ?? null;
}

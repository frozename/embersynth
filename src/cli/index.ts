import { loadConfig } from '../config/loader.js';
import { NodeRegistry } from '../registry/registry.js';
import { getAdapter } from '../adapters/index.js';
import type { EmberSynthConfig, NodeDefinition, HealthStatus } from '../types/index.js';
// Force adapter registration
import '../adapters/index.js';

const USAGE = `
embersynth CLI

Usage:
  bun run src/cli/index.ts <command> [options]

Commands:
  status              Show node status and health
  check-config        Validate configuration file
  test-node <id>      Test connectivity to a specific node
  list-nodes          List all configured nodes
  list-profiles       List all routing profiles
  help                Show this help message

Options:
  --config <path>     Path to config file (default: auto-detect)
`.trim();

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const configIdx = args.indexOf('--config');
  const configPath = configIdx >= 0 ? args[configIdx + 1] : undefined;

  switch (command) {
    case 'status':
      return cmdStatus(configPath);
    case 'check-config':
      return cmdCheckConfig(configPath);
    case 'test-node':
      return cmdTestNode(args[1], configPath);
    case 'list-nodes':
      return cmdListNodes(configPath);
    case 'list-profiles':
      return cmdListProfiles(configPath);
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

function loadAndReport(configPath?: string): EmberSynthConfig {
  try {
    const config = loadConfig(configPath);
    return config;
  } catch (err) {
    console.error(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function cmdStatus(configPath?: string) {
  const config = loadAndReport(configPath);
  const registry = new NodeRegistry();
  registry.load(config.nodes);

  console.log(`EmberSynth Status`);
  console.log(`═══════════════════════════════════════`);
  console.log(`Server: ${config.server.host}:${config.server.port}`);
  console.log(`Nodes: ${config.nodes.length} configured, ${config.nodes.filter((n) => n.enabled).length} enabled`);
  console.log(`Profiles: ${config.profiles.map((p) => p.id).join(', ')}`);
  console.log(`Models: ${Object.keys(config.syntheticModels).join(', ')}`);
  console.log();

  // Check health of each node
  console.log(`Node Health:`);
  console.log(`───────────────────────────────────────`);

  for (const node of config.nodes) {
    const adapter = getAdapter(node.providerType);
    if (!adapter) {
      console.log(`  ${node.id}: [no adapter: ${node.providerType}]`);
      continue;
    }

    if (!node.enabled) {
      console.log(`  ${node.id}: [disabled]`);
      continue;
    }

    try {
      const health = await adapter.checkHealth(node);
      const icon = health.state === 'healthy' ? '+' : health.state === 'degraded' ? '~' : 'x';
      const latency = health.latencyMs ? `${health.latencyMs}ms` : 'n/a';
      console.log(`  [${icon}] ${node.id} (${node.capabilities.join(', ')}) — ${health.state} — ${latency}`);
    } catch (err) {
      console.log(`  [x] ${node.id} — error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function cmdCheckConfig(configPath?: string) {
  const config = loadAndReport(configPath);
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check nodes
  const nodeIds = new Set<string>();
  for (const node of config.nodes) {
    if (nodeIds.has(node.id)) {
      errors.push(`Duplicate node ID: ${node.id}`);
    }
    nodeIds.add(node.id);

    if (!node.endpoint) {
      errors.push(`Node "${node.id}" has no endpoint`);
    }

    if (node.capabilities.length === 0) {
      warnings.push(`Node "${node.id}" has no capabilities defined`);
    }

    if (!node.modelId) {
      warnings.push(`Node "${node.id}" has no modelId (will use "default")`);
    }
  }

  // Check profiles
  const profileIds = new Set<string>();
  for (const profile of config.profiles) {
    if (profileIds.has(profile.id)) {
      errors.push(`Duplicate profile ID: ${profile.id}`);
    }
    profileIds.add(profile.id);
  }

  // Check synthetic model mapping
  for (const [model, profileId] of Object.entries(config.syntheticModels)) {
    if (!profileIds.has(profileId)) {
      errors.push(`Synthetic model "${model}" maps to unknown profile "${profileId}"`);
    }
  }

  // Check capability coverage
  const allCapabilities = new Set(config.nodes.filter((n) => n.enabled).flatMap((n) => n.capabilities));
  if (!allCapabilities.has('reasoning')) {
    warnings.push('No enabled node provides "reasoning" capability — most requests will fail');
  }

  // Report
  console.log('Config Validation');
  console.log('═══════════════════════════════════════');
  console.log(`Nodes: ${config.nodes.length}`);
  console.log(`Profiles: ${config.profiles.length}`);
  console.log(`Synthetic Models: ${Object.keys(config.syntheticModels).length}`);
  console.log(`Capabilities: ${[...allCapabilities].join(', ') || '(none)'}`);
  console.log();

  if (errors.length > 0) {
    console.log(`Errors (${errors.length}):`);
    for (const e of errors) console.log(`  [x] ${e}`);
    console.log();
  }

  if (warnings.length > 0) {
    console.log(`Warnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  [!] ${w}`);
    console.log();
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log('All checks passed.');
  } else if (errors.length === 0) {
    console.log('Config is valid (with warnings).');
  } else {
    console.log('Config has errors.');
    process.exit(1);
  }
}

async function cmdTestNode(nodeId: string, configPath?: string) {
  if (!nodeId || nodeId.startsWith('--')) {
    console.error('Usage: test-node <node-id>');
    process.exit(1);
  }

  const config = loadAndReport(configPath);
  const node = config.nodes.find((n) => n.id === nodeId);

  if (!node) {
    console.error(`Node "${nodeId}" not found. Available: ${config.nodes.map((n) => n.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`Testing node: ${node.id}`);
  console.log(`───────────────────────────────────────`);
  console.log(`  Label: ${node.label}`);
  console.log(`  Endpoint: ${node.endpoint}`);
  console.log(`  Provider: ${node.providerType}`);
  console.log(`  Model: ${node.modelId ?? '(default)'}`);
  console.log(`  Capabilities: ${node.capabilities.join(', ')}`);
  console.log(`  Tags: ${node.tags.join(', ')}`);
  console.log(`  Enabled: ${node.enabled}`);
  console.log();

  const adapter = getAdapter(node.providerType);
  if (!adapter) {
    console.error(`No adapter for provider type: ${node.providerType}`);
    process.exit(1);
  }

  // Health check
  console.log('Health check...');
  try {
    const health = await adapter.checkHealth(node);
    console.log(`  State: ${health.state}`);
    console.log(`  Latency: ${health.latencyMs ?? 'n/a'}ms`);
    if (health.error) console.log(`  Error: ${health.error}`);
  } catch (err) {
    console.log(`  Failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Simple inference test
  if (node.capabilities.includes('reasoning') || node.capabilities.includes('vision')) {
    console.log();
    console.log('Inference test...');
    try {
      const start = Date.now();
      const response = await adapter.sendRequest(node, {
        messages: [{ role: 'user', content: 'Reply with exactly: "ok"' }],
        maxTokens: 10,
        temperature: 0,
      });
      const elapsed = Date.now() - start;
      console.log(`  Response: "${response.content.trim().slice(0, 100)}"`);
      console.log(`  Latency: ${elapsed}ms`);
      console.log(`  Finish reason: ${response.finishReason}`);
    } catch (err) {
      console.log(`  Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Embedding test
  if (node.capabilities.includes('embedding') && adapter.sendEmbeddingRequest) {
    console.log();
    console.log('Embedding test...');
    try {
      const start = Date.now();
      const response = await adapter.sendEmbeddingRequest(node, {
        input: ['test'],
      });
      const elapsed = Date.now() - start;
      console.log(`  Dimensions: ${response.embeddings[0]?.length ?? 0}`);
      console.log(`  Latency: ${elapsed}ms`);
    } catch (err) {
      console.log(`  Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function cmdListNodes(configPath?: string) {
  const config = loadAndReport(configPath);

  console.log('Configured Nodes');
  console.log('═══════════════════════════════════════');

  for (const node of config.nodes) {
    const status = node.enabled ? 'enabled' : 'disabled';
    console.log(`  ${node.id}`);
    console.log(`    Label: ${node.label}`);
    console.log(`    Endpoint: ${node.endpoint}`);
    console.log(`    Provider: ${node.providerType}`);
    console.log(`    Model: ${node.modelId ?? '(default)'}`);
    console.log(`    Capabilities: ${node.capabilities.join(', ')}`);
    console.log(`    Tags: ${node.tags.join(', ')}`);
    console.log(`    Priority: ${node.priority}`);
    console.log(`    Status: ${status}`);
    console.log();
  }
}

function cmdListProfiles(configPath?: string) {
  const config = loadAndReport(configPath);

  console.log('Routing Profiles');
  console.log('═══════════════════════════════════════');

  for (const p of config.profiles) {
    console.log(`  ${p.id}: ${p.label}`);
    if (p.description) console.log(`    ${p.description}`);
    if (p.requiredTags) console.log(`    Required tags: ${p.requiredTags.join(', ')}`);
    if (p.excludedTags) console.log(`    Excluded tags: ${p.excludedTags.join(', ')}`);
    if (p.maxStages) console.log(`    Max stages: ${p.maxStages}`);
    if (p.synthesisRequired) console.log(`    Synthesis: required`);
    console.log();
  }

  console.log('Synthetic Model Mapping');
  console.log('───────────────────────────────────────');
  for (const [model, profile] of Object.entries(config.syntheticModels)) {
    console.log(`  ${model} → ${profile}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

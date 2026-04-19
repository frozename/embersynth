import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appendAudit, toTextContent } from '@nova/mcp-shared';
import { loadConfig, resolveConfigPath } from '../config/loader.js';
import { NodeRegistry } from '../registry/registry.js';
import { planRoute } from '../router/index.js';
import { healthAll } from '../health/index.js';
import { tailEvidence } from '../evidence/index.js';
import type { EmberSynthConfig, NodeDefinition } from '../types/index.js';

/**
 * `@embersynth/mcp` — Model Context Protocol server exposing
 * embersynth's operator surface to MCP-speaking clients.
 *
 * Read-only surface (config + live state):
 *   * `embersynth.config.show`      — the loaded config envelope
 *   * `embersynth.nodes.list`       — node definitions
 *   * `embersynth.nodes.inspect`    — one node by id
 *   * `embersynth.profiles.list`    — routing profiles
 *   * `embersynth.profiles.inspect` — one profile by name/id
 *   * `embersynth.synthetic.list`   — syntheticModels map
 *   * `embersynth.route.simulate`   — plan-only (pure) routing sim
 *   * `embersynth.health.all`       — one-shot reachability probe
 *   * `embersynth.evidence.tail`    — tail of the routing-decision log
 *
 * Mutation (dry-run-safe):
 *   * `embersynth.reload`           — reread embersynth.yaml; dryRun
 *                                     computes + returns a diff, wet
 *                                     swaps the live in-memory config.
 *
 * Deliberately excluded:
 *   * Writes to embersynth.yaml — llamactl owns that file. `reload`
 *     only rereads disk.
 */

const SERVER_SLUG = 'embersynth';

interface LiveState {
  path?: string;
  config: EmberSynthConfig;
  registry: NodeRegistry;
}

export interface BuildServerOptions {
  name?: string;
  version?: string;
  /** Initial config path. Falls back to $EMBERSYNTH_CONFIG, then default search. */
  configPath?: string;
}

function buildRegistry(nodes: NodeDefinition[]): NodeRegistry {
  const registry = new NodeRegistry();
  registry.load(nodes);
  return registry;
}

function diffConfigs(
  before: EmberSynthConfig,
  after: EmberSynthConfig,
): {
  nodes: { added: string[]; removed: string[]; changed: string[] };
  profiles: { added: string[]; removed: string[]; changed: string[] };
  syntheticModels: { added: string[]; removed: string[]; changed: string[] };
  policy: { changed: boolean };
  server: { changed: boolean };
} {
  const nodeIdsBefore = new Set(before.nodes.map((n) => n.id));
  const nodeIdsAfter = new Set(after.nodes.map((n) => n.id));
  const nodesByIdBefore = new Map(before.nodes.map((n) => [n.id, n]));
  const nodesByIdAfter = new Map(after.nodes.map((n) => [n.id, n]));
  const nodesAdded = [...nodeIdsAfter].filter((id) => !nodeIdsBefore.has(id));
  const nodesRemoved = [...nodeIdsBefore].filter((id) => !nodeIdsAfter.has(id));
  const nodesChanged: string[] = [];
  for (const id of nodeIdsAfter) {
    if (!nodeIdsBefore.has(id)) continue;
    if (JSON.stringify(nodesByIdBefore.get(id)) !== JSON.stringify(nodesByIdAfter.get(id))) {
      nodesChanged.push(id);
    }
  }

  const profIdsBefore = new Set(before.profiles.map((p) => p.id));
  const profIdsAfter = new Set(after.profiles.map((p) => p.id));
  const profsByIdBefore = new Map(before.profiles.map((p) => [p.id, p]));
  const profsByIdAfter = new Map(after.profiles.map((p) => [p.id, p]));
  const profilesAdded = [...profIdsAfter].filter((id) => !profIdsBefore.has(id));
  const profilesRemoved = [...profIdsBefore].filter((id) => !profIdsAfter.has(id));
  const profilesChanged: string[] = [];
  for (const id of profIdsAfter) {
    if (!profIdsBefore.has(id)) continue;
    if (JSON.stringify(profsByIdBefore.get(id)) !== JSON.stringify(profsByIdAfter.get(id))) {
      profilesChanged.push(id);
    }
  }

  const synthBeforeKeys = new Set(Object.keys(before.syntheticModels));
  const synthAfterKeys = new Set(Object.keys(after.syntheticModels));
  const synthAdded = [...synthAfterKeys].filter((k) => !synthBeforeKeys.has(k));
  const synthRemoved = [...synthBeforeKeys].filter((k) => !synthAfterKeys.has(k));
  const synthChanged: string[] = [];
  for (const k of synthAfterKeys) {
    if (!synthBeforeKeys.has(k)) continue;
    if (before.syntheticModels[k] !== after.syntheticModels[k]) synthChanged.push(k);
  }

  return {
    nodes: { added: nodesAdded, removed: nodesRemoved, changed: nodesChanged },
    profiles: { added: profilesAdded, removed: profilesRemoved, changed: profilesChanged },
    syntheticModels: { added: synthAdded, removed: synthRemoved, changed: synthChanged },
    policy: { changed: JSON.stringify(before.policy) !== JSON.stringify(after.policy) },
    server: { changed: JSON.stringify(before.server) !== JSON.stringify(after.server) },
  };
}

function sanitizeConfig(cfg: EmberSynthConfig): EmberSynthConfig {
  return {
    ...cfg,
    nodes: cfg.nodes.map((n) => ({
      ...n,
      auth:
        n.auth && 'type' in n.auth && n.auth.type !== 'none'
          ? { type: n.auth.type, tokenRef: '[redacted]' as unknown as string }
          : n.auth,
    })),
  } as EmberSynthConfig;
}

export function buildEmbersynthMcpServer(opts?: BuildServerOptions): McpServer {
  const server = new McpServer({
    name: opts?.name ?? 'embersynth',
    version: opts?.version ?? '0.0.0',
  });

  // Live state is lazy: first tool call that needs it resolves the
  // config path (opts.configPath → $EMBERSYNTH_CONFIG → default search)
  // and loads the config + registry. `reload` mutates this ref in-place
  // so every subsequent call sees the new state.
  let live: LiveState | null = null;

  function ensureLive(): LiveState {
    if (live) return live;
    const explicit = opts?.configPath ?? process.env.EMBERSYNTH_CONFIG;
    const path = explicit ?? resolveConfigPath();
    const cfg = loadConfig(path);
    live = { path, config: cfg, registry: buildRegistry(cfg.nodes) };
    return live;
  }

  server.registerTool(
    'embersynth.config.show',
    {
      title: 'Show loaded embersynth.yaml',
      description:
        'Load the config embersynth would run with (honoring EMBERSYNTH_CONFIG / CWD search path) and return its resolved shape. Secrets in node `auth` blocks are stripped.',
      inputSchema: {
        path: z.string().optional().describe('Override the config file path.'),
      },
    },
    async (input) => {
      // config.show intentionally re-reads disk (matches existing
      // smoke-test contract — it always reflects what's on disk, not
      // what `reload` last installed in-memory).
      const path = input.path
        ? resolveConfigPath(input.path)
        : (ensureLive().path ?? resolveConfigPath());
      const cfg = input.path ? loadConfig(input.path) : ensureLive().config;
      const sanitized = sanitizeConfig(cfg);
      appendAudit({ server: SERVER_SLUG, tool: 'embersynth.config.show', input });
      return toTextContent({ path: path ?? null, config: sanitized });
    },
  );

  server.registerTool(
    'embersynth.nodes.list',
    {
      title: 'List node definitions',
      description:
        'Return every node embersynth is configured to route to — id, label, endpoint, capabilities, tags, priority. Auth blocks are redacted.',
      inputSchema: {
        enabledOnly: z
          .boolean()
          .default(false)
          .describe('Skip nodes with `enabled: false`.'),
        path: z.string().optional(),
      },
    },
    async (input) => {
      const cfg = input.path ? loadConfig(input.path) : ensureLive().config;
      const rows = cfg.nodes
        .filter((n) => !input.enabledOnly || n.enabled)
        .map((n) => ({
          id: n.id,
          label: n.label,
          endpoint: n.endpoint,
          enabled: n.enabled,
          capabilities: n.capabilities,
          tags: n.tags,
          priority: n.priority,
          providerType: n.providerType,
          modelId: n.modelId,
        }));
      appendAudit({ server: SERVER_SLUG, tool: 'embersynth.nodes.list', input });
      return toTextContent({ count: rows.length, nodes: rows });
    },
  );

  server.registerTool(
    'embersynth.nodes.inspect',
    {
      title: 'Inspect one node by id',
      description:
        'Return the full node definition for a single node id. Auth block is redacted. Errors if the id is unknown.',
      inputSchema: {
        id: z.string().min(1).describe('Node id as declared in embersynth.yaml.'),
        path: z.string().optional(),
      },
    },
    async (input) => {
      const cfg = input.path ? loadConfig(input.path) : ensureLive().config;
      const node = cfg.nodes.find((n) => n.id === input.id);
      if (!node) {
        throw new Error(
          `Unknown node id "${input.id}". Available: ${cfg.nodes.map((n) => n.id).join(', ') || '(none)'}`,
        );
      }
      const sanitized =
        node.auth && 'type' in node.auth && node.auth.type !== 'none'
          ? { ...node, auth: { type: node.auth.type, tokenRef: '[redacted]' } }
          : node;
      appendAudit({ server: SERVER_SLUG, tool: 'embersynth.nodes.inspect', input });
      return toTextContent({ node: sanitized });
    },
  );

  server.registerTool(
    'embersynth.profiles.list',
    {
      title: 'List routing profiles',
      description:
        'Return every profile declared in embersynth.yaml. Profiles are the units a gateway (llamactl) fans out as synthetic models.',
      inputSchema: {
        path: z.string().optional(),
      },
    },
    async (input) => {
      const cfg = input.path ? loadConfig(input.path) : ensureLive().config;
      appendAudit({ server: SERVER_SLUG, tool: 'embersynth.profiles.list', input });
      return toTextContent({ count: cfg.profiles.length, profiles: cfg.profiles });
    },
  );

  server.registerTool(
    'embersynth.profiles.inspect',
    {
      title: 'Inspect one profile by name',
      description:
        'Return the full profile definition for a single profile id. Errors if the name is unknown.',
      inputSchema: {
        name: z.string().min(1).describe('Profile id (e.g. "auto", "private-first").'),
        path: z.string().optional(),
      },
    },
    async (input) => {
      const cfg = input.path ? loadConfig(input.path) : ensureLive().config;
      const profile = cfg.profiles.find((p) => p.id === input.name);
      if (!profile) {
        throw new Error(
          `Unknown profile "${input.name}". Available: ${cfg.profiles.map((p) => p.id).join(', ') || '(none)'}`,
        );
      }
      appendAudit({ server: SERVER_SLUG, tool: 'embersynth.profiles.inspect', input });
      return toTextContent({ profile });
    },
  );

  server.registerTool(
    'embersynth.synthetic.list',
    {
      title: 'List synthetic models',
      description:
        'Return the syntheticModels map — the names (e.g. `fusion-auto`, `fusion-vision`) gateways like llamactl project as synthetic-model nodes routed through the matching profile.',
      inputSchema: {
        path: z.string().optional(),
      },
    },
    async (input) => {
      const cfg = input.path ? loadConfig(input.path) : ensureLive().config;
      const map = cfg.syntheticModels;
      appendAudit({ server: SERVER_SLUG, tool: 'embersynth.synthetic.list', input });
      return toTextContent({
        count: Object.keys(map).length,
        syntheticModels: map,
      });
    },
  );

  server.registerTool(
    'embersynth.route.simulate',
    {
      title: 'Simulate a routing decision (plan-only)',
      description:
        'Run the classifier + planner against a UnifiedAiRequest without executing. Returns the scored candidate set for the final stage and the winner. Pure: no network calls, no state mutation.',
      inputSchema: {
        request: z
          .looseObject({
            model: z.string(),
            messages: z.array(z.any()),
          })
          .describe('UnifiedAiRequest (OpenAI-compatible chat-completion envelope).'),
      },
    },
    async (input) => {
      const { config, registry } = ensureLive();
      const result = planRoute(
        input.request as Parameters<typeof planRoute>[0],
        config,
        registry,
      );
      appendAudit({ server: SERVER_SLUG, tool: 'embersynth.route.simulate', input });
      if (!result.ok) {
        return toTextContent({ ok: false, error: result.error });
      }
      return toTextContent({
        ok: true,
        profileId: result.result.profileId,
        winner: result.result.winner,
        candidates: result.result.candidates,
        plan: result.result.plan,
      });
    },
  );

  server.registerTool(
    'embersynth.health.all',
    {
      title: 'Probe reachability of every enabled node',
      description:
        'For each enabled node, GET `<endpoint>/<health.endpoint>` with a 2s timeout. Returns per-node reachability + latency and a fleet-wide worst severity (`ok` | `degraded` | `down`).',
      inputSchema: {},
    },
    async (input) => {
      const { config } = ensureLive();
      const report = await healthAll(config);
      appendAudit({ server: SERVER_SLUG, tool: 'embersynth.health.all', input });
      return toTextContent(report);
    },
  );

  server.registerTool(
    'embersynth.evidence.tail',
    {
      title: 'Tail the routing-decision evidence log',
      description:
        'Read the last N lines from the routing-decision JSONL sink (default 50). Sink path is $EMBERSYNTH_EVIDENCE_PATH or `~/.embersynth/evidence.jsonl`.',
      inputSchema: {
        limit: z.number().int().positive().max(10_000).default(50),
      },
    },
    async (input) => {
      const records = tailEvidence({ limit: input.limit });
      appendAudit({ server: SERVER_SLUG, tool: 'embersynth.evidence.tail', input });
      return toTextContent({ count: records.length, records });
    },
  );

  server.registerTool(
    'embersynth.reload',
    {
      title: 'Reread embersynth.yaml (dryRun-safe)',
      description:
        'Reread the currently-loaded embersynth.yaml from disk. `dryRun: true` computes a field-level diff vs the live in-memory config and returns it without swapping. `dryRun: false` swaps the live config + registry and emits one audit entry. Never writes the YAML file.',
      inputSchema: {
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => {
      const current = ensureLive();
      const path = current.path ?? resolveConfigPath();
      if (!path) {
        throw new Error(
          'No embersynth.yaml found. Set $EMBERSYNTH_CONFIG or add a config at the default search path.',
        );
      }
      let nextConfig: EmberSynthConfig;
      try {
        nextConfig = loadConfig(path);
      } catch (err) {
        throw new Error(
          `reload failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const diff = diffConfigs(current.config, nextConfig);
      if (input.dryRun) {
        // dryRun: never audit, never swap — pure preview.
        return toTextContent({ ok: true, dryRun: true, path, diff });
      }
      // Wet run: swap live reference + rebuild registry.
      current.config = nextConfig;
      current.registry = buildRegistry(nextConfig.nodes);
      live = current;
      appendAudit({
        server: SERVER_SLUG,
        tool: 'embersynth.reload',
        input,
        dryRun: false,
        result: {
          path,
          nodes: nextConfig.nodes.length,
          profiles: nextConfig.profiles.length,
          diff,
        },
      });
      return toTextContent({ ok: true, dryRun: false, path, diff });
    },
  );

  return server;
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appendAudit, toTextContent } from '@nova/mcp-shared';
import { loadConfig, resolveConfigPath } from '../config/loader.js';

/**
 * `@embersynth/mcp` — Model Context Protocol server exposing
 * embersynth's operator surface to MCP-speaking clients.
 *
 * Scope today (spike slice — config-based reads only):
 *   * `embersynth.config.show`      — the loaded config envelope
 *   * `embersynth.nodes.list`       — node definitions (id, label,
 *                                    capabilities, tags, priority)
 *   * `embersynth.profiles.list`    — routing profiles from config
 *   * `embersynth.synthetic.list`   — syntheticModels map (name →
 *                                    profile id) that gateways like
 *                                    llamactl fan out on
 *
 * Deliberately excluded:
 *   * Mutations — embersynth.yaml is llamactl-authored; writes route
 *     through @llamactl/mcp's `llamactl.embersynth.sync`.
 *   * Runtime tools (route.simulate, evidence.tail, health) — those
 *     want a live registry + health monitor + evidence store wired
 *     up; warrants its own focused slice.
 */

const SERVER_SLUG = 'embersynth';

export function buildEmbersynthMcpServer(opts?: { name?: string; version?: string }): McpServer {
  const server = new McpServer({
    name: opts?.name ?? 'embersynth',
    version: opts?.version ?? '0.0.0',
  });

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
      const path = resolveConfigPath(input.path);
      const cfg = loadConfig(input.path);
      const sanitized = {
        ...cfg,
        nodes: cfg.nodes.map((n) => ({
          ...n,
          auth:
            n.auth && 'type' in n.auth && n.auth.type !== 'none'
              ? { type: n.auth.type, tokenRef: '[redacted]' }
              : n.auth,
        })),
      };
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
      const cfg = loadConfig(input.path);
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
      const cfg = loadConfig(input.path);
      appendAudit({ server: SERVER_SLUG, tool: 'embersynth.profiles.list', input });
      return toTextContent({ count: cfg.profiles.length, profiles: cfg.profiles });
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
      const cfg = loadConfig(input.path);
      const map = cfg.syntheticModels;
      appendAudit({ server: SERVER_SLUG, tool: 'embersynth.synthetic.list', input });
      return toTextContent({
        count: Object.keys(map).length,
        syntheticModels: map,
      });
    },
  );

  return server;
}

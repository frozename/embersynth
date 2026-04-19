import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { buildEmbersynthMcpServer } from '../src/mcp/index.js';

/**
 * Smoke test for @embersynth/mcp. Boots the server + Client over the
 * SDK's InMemoryTransport and exercises each config-read tool against
 * a tempdir-scoped embersynth.yaml. Audits land in the same tempdir
 * so the real ~/.llamactl/mcp/audit/ is never touched.
 */

let runtimeDir = '';
let auditDir = '';
let configPath = '';
let evidencePath = '';
const originalEnv = { ...process.env };

function baseConfigYaml(): string {
  return stringifyYaml({
    server: { host: '127.0.0.1', port: 7777 },
    nodes: [
      {
        id: 'agent-local',
        label: 'llamactl agent local',
        endpoint: 'http://127.0.0.1:8080/v1',
        transport: 'http',
        enabled: true,
        capabilities: ['reasoning'],
        tags: ['llamactl', 'agent', 'private'],
        providerType: 'openai-compatible',
        modelId: 'default',
        priority: 5,
        auth: { type: 'bearer', token: 'secret-goes-here' },
        health: { endpoint: '/health', intervalMs: 30000, timeoutMs: 5000 },
      },
      {
        id: 'provider-openai',
        label: 'openai',
        endpoint: 'https://api.openai.com/v1',
        transport: 'http',
        enabled: false,
        capabilities: ['reasoning', 'tools'],
        tags: ['cloud'],
        providerType: 'openai-compatible',
        modelId: 'default',
        priority: 10,
        auth: { type: 'bearer', token: '$OPENAI_API_KEY' },
      },
    ],
    profiles: [
      { id: 'auto', label: 'Automatic', preferLowerPriority: true },
      { id: 'private-first', label: 'Private First', requiredTags: ['private'] },
    ],
    syntheticModels: {
      'fusion-auto': 'auto',
      'fusion-private-first': 'private-first',
    },
  });
}

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'embersynth-mcp-runtime-'));
  auditDir = mkdtempSync(join(tmpdir(), 'embersynth-mcp-audit-'));
  configPath = join(runtimeDir, 'embersynth.yaml');
  evidencePath = join(runtimeDir, 'evidence.jsonl');
  writeFileSync(configPath, baseConfigYaml());
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    LLAMACTL_MCP_AUDIT_DIR: auditDir,
    EMBERSYNTH_CONFIG: configPath,
    EMBERSYNTH_EVIDENCE_PATH: evidencePath,
  });
});
afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
});

async function connected() {
  const server = buildEmbersynthMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  return content[0]?.text ?? '';
}

function auditLines(): Array<Record<string, unknown>> {
  if (!existsSync(auditDir)) return [];
  const files = readdirSync(auditDir).filter((f) => f.startsWith('embersynth-'));
  const out: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const body = readFileSync(join(auditDir, f), 'utf8');
    for (const line of body.trim().split('\n')) if (line) out.push(JSON.parse(line));
  }
  return out;
}

describe('@embersynth/mcp surface', () => {
  test('listTools advertises the embersynth operator tools', async () => {
    const client = await connected();
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'embersynth.config.show',
      'embersynth.evidence.tail',
      'embersynth.health.all',
      'embersynth.nodes.inspect',
      'embersynth.nodes.list',
      'embersynth.profiles.inspect',
      'embersynth.profiles.list',
      'embersynth.reload',
      'embersynth.route.simulate',
      'embersynth.synthetic.list',
    ]);
  });

  test('embersynth.config.show returns the loaded shape with auth redacted', async () => {
    const client = await connected();
    const result = await client.callTool({
      name: 'embersynth.config.show',
      arguments: { path: configPath },
    });
    const parsed = JSON.parse(textOf(result)) as {
      path: string;
      config: {
        nodes: Array<{ id: string; auth?: { type: string; token?: string; tokenRef?: string } }>;
      };
    };
    expect(parsed.path).toBe(configPath);
    for (const node of parsed.config.nodes) {
      // Token field must never leak through; only redacted ref.
      expect(node.auth?.token).toBeUndefined();
      if (node.auth && node.auth.type !== 'none') {
        expect(node.auth.tokenRef).toBe('[redacted]');
      }
    }
    const audits = auditLines();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.tool).toBe('embersynth.config.show');
  });

  test('embersynth.nodes.list respects enabledOnly', async () => {
    const client = await connected();
    const all = JSON.parse(
      textOf(
        await client.callTool({
          name: 'embersynth.nodes.list',
          arguments: { path: configPath },
        }),
      ),
    ) as { count: number; nodes: Array<{ id: string; enabled: boolean }> };
    expect(all.count).toBe(2);

    const enabled = JSON.parse(
      textOf(
        await client.callTool({
          name: 'embersynth.nodes.list',
          arguments: { path: configPath, enabledOnly: true },
        }),
      ),
    ) as { count: number; nodes: Array<{ id: string }> };
    expect(enabled.count).toBe(1);
    expect(enabled.nodes[0]!.id).toBe('agent-local');
  });

  test('embersynth.profiles.list + synthetic.list round-trip from the file', async () => {
    const client = await connected();
    const profiles = JSON.parse(
      textOf(
        await client.callTool({
          name: 'embersynth.profiles.list',
          arguments: { path: configPath },
        }),
      ),
    ) as { count: number; profiles: Array<{ id: string }> };
    expect(profiles.profiles.map((p) => p.id).sort()).toEqual(['auto', 'private-first']);

    const synth = JSON.parse(
      textOf(
        await client.callTool({
          name: 'embersynth.synthetic.list',
          arguments: { path: configPath },
        }),
      ),
    ) as { count: number; syntheticModels: Record<string, string> };
    expect(synth.syntheticModels['fusion-private-first']).toBe('private-first');
  });
});

describe('@embersynth/mcp nodes.inspect', () => {
  test('returns the full node definition with auth redacted', async () => {
    const client = await connected();
    const result = await client.callTool({
      name: 'embersynth.nodes.inspect',
      arguments: { id: 'agent-local', path: configPath },
    });
    const parsed = JSON.parse(textOf(result)) as {
      node: {
        id: string;
        label: string;
        priority: number;
        auth: { type: string; token?: string; tokenRef?: string };
      };
    };
    expect(parsed.node.id).toBe('agent-local');
    expect(parsed.node.label).toBe('llamactl agent local');
    expect(parsed.node.priority).toBe(5);
    expect(parsed.node.auth.token).toBeUndefined();
    expect(parsed.node.auth.tokenRef).toBe('[redacted]');
  });

  test('unknown id surfaces as an MCP error, not a crash', async () => {
    const client = await connected();
    const result = (await client.callTool({
      name: 'embersynth.nodes.inspect',
      arguments: { id: 'does-not-exist', path: configPath },
    })) as { isError?: boolean; content?: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toMatch(/Unknown node id/);
  });

  test('missing required `id` is rejected with an MCP error (not a crash)', async () => {
    const client = await connected();
    const result = (await client.callTool({
      name: 'embersynth.nodes.inspect',
      arguments: {} as unknown as Record<string, unknown>,
    })) as { isError?: boolean; content?: Array<{ text: string }> };
    expect(result.isError).toBe(true);
  });
});

describe('@embersynth/mcp profiles.inspect', () => {
  test('returns the full profile by id', async () => {
    const client = await connected();
    const result = await client.callTool({
      name: 'embersynth.profiles.inspect',
      arguments: { name: 'private-first', path: configPath },
    });
    const parsed = JSON.parse(textOf(result)) as {
      profile: { id: string; requiredTags?: string[] };
    };
    expect(parsed.profile.id).toBe('private-first');
    expect(parsed.profile.requiredTags).toEqual(['private']);
  });

  test('unknown profile name surfaces as an MCP error', async () => {
    const client = await connected();
    const result = (await client.callTool({
      name: 'embersynth.profiles.inspect',
      arguments: { name: 'not-a-profile', path: configPath },
    })) as { isError?: boolean; content?: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toMatch(/Unknown profile/);
  });
});

describe('@embersynth/mcp route.simulate', () => {
  test('returns a deterministic winner + candidates for a known model', async () => {
    const client = await connected();
    const result = await client.callTool({
      name: 'embersynth.route.simulate',
      arguments: {
        request: {
          model: 'fusion-auto',
          messages: [
            { role: 'user', content: 'Hello, world.' },
          ],
        },
      },
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      profileId?: string;
      winner?: { nodeId: string };
      candidates?: Array<{ nodeId: string; score: number; reasons: string[] }>;
      plan?: { profileId: string; stages: unknown[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.profileId).toBe('auto');
    // Only `agent-local` is enabled, has `reasoning`, and matches the
    // auto profile, so it is the deterministic winner.
    expect(parsed.winner?.nodeId).toBe('agent-local');
    const candidateIds = (parsed.candidates ?? []).map((c) => c.nodeId);
    expect(candidateIds).toContain('agent-local');
    // Score must be in [0, 1].
    for (const c of parsed.candidates ?? []) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
      expect(c.reasons.length).toBeGreaterThan(0);
    }
    expect(parsed.plan?.profileId).toBe('auto');
  });

  test('unknown model surfaces ok:false with a 400-ish error', async () => {
    const client = await connected();
    const result = await client.callTool({
      name: 'embersynth.route.simulate',
      arguments: {
        request: {
          model: 'not-a-model',
          messages: [{ role: 'user', content: 'x' }],
        },
      },
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      error?: { status: number; message: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.status).toBe(400);
  });
});

describe('@embersynth/mcp health.all', () => {
  test('probes every enabled node and rolls up a worst severity', async () => {
    const client = await connected();
    const result = await client.callTool({
      name: 'embersynth.health.all',
      arguments: {},
    });
    const parsed = JSON.parse(textOf(result)) as {
      nodes: Array<{ id: string; reachable: boolean; error?: string; latencyMs?: number }>;
      worst: 'ok' | 'degraded' | 'down';
    };
    // Only `agent-local` is enabled in the fixture; the endpoint points
    // at 127.0.0.1:8080 which no test server is listening on, so the
    // probe ECONNREFUSEDs and the fleet rolls up to `down`.
    expect(parsed.nodes.length).toBe(1);
    expect(parsed.nodes[0]!.id).toBe('agent-local');
    expect(parsed.nodes[0]!.reachable).toBe(false);
    expect(parsed.worst).toBe('down');
  });
});

describe('@embersynth/mcp evidence.tail', () => {
  test('returns seeded records in append order, limited to `limit`', async () => {
    // Seed 3 records into the sink tempfile directly — no router call
    // required. The tool just reads the last N lines.
    const seed = [
      { ts: '2026-01-01T00:00:00.000Z', request: { model: 'a' }, winner: { nodeId: 'n1' }, candidates: [] },
      { ts: '2026-01-01T00:00:01.000Z', request: { model: 'b' }, winner: { nodeId: 'n2' }, candidates: [] },
      { ts: '2026-01-01T00:00:02.000Z', request: { model: 'c' }, winner: { nodeId: 'n3' }, candidates: [] },
    ];
    writeFileSync(evidencePath, seed.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const client = await connected();
    const result = await client.callTool({
      name: 'embersynth.evidence.tail',
      arguments: { limit: 10 },
    });
    const parsed = JSON.parse(textOf(result)) as {
      count: number;
      records: Array<{ ts: string; request: { model: string }; winner: { nodeId: string } }>;
    };
    expect(parsed.count).toBe(3);
    expect(parsed.records.map((r) => r.request.model)).toEqual(['a', 'b', 'c']);
    expect(parsed.records.map((r) => r.winner.nodeId)).toEqual(['n1', 'n2', 'n3']);
  });

  test('honors `limit` and returns only the most recent N', async () => {
    const seed = Array.from({ length: 5 }, (_, i) => ({
      ts: `2026-01-01T00:00:0${i}.000Z`,
      request: { model: `m${i}` },
      winner: { nodeId: `n${i}` },
      candidates: [],
    }));
    writeFileSync(evidencePath, seed.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const client = await connected();
    const result = await client.callTool({
      name: 'embersynth.evidence.tail',
      arguments: { limit: 2 },
    });
    const parsed = JSON.parse(textOf(result)) as {
      count: number;
      records: Array<{ request: { model: string } }>;
    };
    expect(parsed.count).toBe(2);
    expect(parsed.records.map((r) => r.request.model)).toEqual(['m3', 'm4']);
  });
});

describe('@embersynth/mcp reload', () => {
  test('dryRun:true returns a diff without mutating live state or auditing', async () => {
    const client = await connected();
    // Warm the live config.
    await client.callTool({ name: 'embersynth.config.show', arguments: {} });
    const auditsBefore = auditLines().length;

    // Mutate the yaml on disk: drop `provider-openai`, add a new one.
    writeFileSync(
      configPath,
      stringifyYaml({
        server: { host: '127.0.0.1', port: 7777 },
        nodes: [
          {
            id: 'agent-local',
            label: 'llamactl agent local',
            endpoint: 'http://127.0.0.1:8080/v1',
            transport: 'http',
            enabled: true,
            capabilities: ['reasoning'],
            tags: ['llamactl', 'agent', 'private'],
            providerType: 'openai-compatible',
            modelId: 'default',
            priority: 5,
            auth: { type: 'bearer', token: 'secret-goes-here' },
          },
          {
            id: 'new-node',
            label: 'new',
            endpoint: 'http://127.0.0.1:9090/v1',
            transport: 'http',
            enabled: true,
            capabilities: ['reasoning'],
            tags: ['cloud'],
            providerType: 'openai-compatible',
            modelId: 'default',
            priority: 20,
            auth: { type: 'none' },
          },
        ],
        profiles: [
          { id: 'auto', label: 'Automatic', preferLowerPriority: true },
          { id: 'private-first', label: 'Private First', requiredTags: ['private'] },
        ],
        syntheticModels: {
          'fusion-auto': 'auto',
          'fusion-private-first': 'private-first',
          'fusion-new': 'auto',
        },
      }),
    );

    const result = await client.callTool({
      name: 'embersynth.reload',
      arguments: { dryRun: true },
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      dryRun: boolean;
      path: string;
      diff: {
        nodes: { added: string[]; removed: string[]; changed: string[] };
        syntheticModels: { added: string[]; removed: string[]; changed: string[] };
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.path).toBe(configPath);
    expect(parsed.diff.nodes.added).toEqual(['new-node']);
    expect(parsed.diff.nodes.removed).toEqual(['provider-openai']);
    expect(parsed.diff.syntheticModels.added).toEqual(['fusion-new']);

    // dryRun must not audit. Only the earlier config.show should have.
    const audits = auditLines();
    expect(audits.length).toBe(auditsBefore);
    // Live state must NOT yet reflect the new yaml.
    const nodesList = JSON.parse(
      textOf(
        await client.callTool({
          name: 'embersynth.nodes.list',
          arguments: {},
        }),
      ),
    ) as { nodes: Array<{ id: string }> };
    expect(nodesList.nodes.map((n) => n.id).sort()).toEqual([
      'agent-local',
      'provider-openai',
    ]);
  });

  test('dryRun:false swaps live state and emits exactly one audit entry', async () => {
    const client = await connected();
    // Warm the live config.
    await client.callTool({ name: 'embersynth.config.show', arguments: {} });

    // Rewrite the yaml with a narrower shape.
    writeFileSync(
      configPath,
      stringifyYaml({
        server: { host: '127.0.0.1', port: 7777 },
        nodes: [
          {
            id: 'agent-local',
            label: 'llamactl agent local',
            endpoint: 'http://127.0.0.1:8080/v1',
            transport: 'http',
            enabled: true,
            capabilities: ['reasoning'],
            tags: ['llamactl', 'agent', 'private'],
            providerType: 'openai-compatible',
            modelId: 'default',
            priority: 5,
            auth: { type: 'bearer', token: 'secret-goes-here' },
          },
        ],
        profiles: [{ id: 'auto', label: 'Automatic', preferLowerPriority: true }],
        syntheticModels: { 'fusion-auto': 'auto' },
      }),
    );

    const beforeReloadAudits = auditLines().filter((r) => r.tool === 'embersynth.reload').length;
    expect(beforeReloadAudits).toBe(0);

    const result = await client.callTool({
      name: 'embersynth.reload',
      arguments: { dryRun: false },
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      dryRun: boolean;
      diff: { nodes: { removed: string[] }; profiles: { removed: string[] } };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.diff.nodes.removed).toEqual(['provider-openai']);
    expect(parsed.diff.profiles.removed).toEqual(['private-first']);

    // Exactly one audit entry for the wet reload.
    const reloadAudits = auditLines().filter((r) => r.tool === 'embersynth.reload');
    expect(reloadAudits.length).toBe(1);
    expect(reloadAudits[0]!.dryRun).toBe(false);

    // Live state must now reflect the new yaml — `config.show` (without
    // an explicit path) returns the live in-memory config.
    const shown = JSON.parse(
      textOf(
        await client.callTool({
          name: 'embersynth.config.show',
          arguments: {},
        }),
      ),
    ) as {
      config: { nodes: Array<{ id: string }>; profiles: Array<{ id: string }> };
    };
    expect(shown.config.nodes.map((n) => n.id)).toEqual(['agent-local']);
    expect(shown.config.profiles.map((p) => p.id)).toEqual(['auto']);
  });
});

describe('@embersynth/mcp input validation', () => {
  // Each tool with at least one required (or typed) input must reject
  // malformed arguments with `isError: true` instead of crashing the
  // server. `health.all` and `evidence.tail` are intentionally exempt:
  // both accept empty arguments as valid.

  test('nodes.inspect without required `id` is an MCP error', async () => {
    const client = await connected();
    const result = (await client.callTool({
      name: 'embersynth.nodes.inspect',
      arguments: {} as unknown as Record<string, unknown>,
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  test('profiles.inspect without required `name` is an MCP error', async () => {
    const client = await connected();
    const result = (await client.callTool({
      name: 'embersynth.profiles.inspect',
      arguments: {} as unknown as Record<string, unknown>,
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  test('route.simulate without required `request` is an MCP error', async () => {
    const client = await connected();
    const result = (await client.callTool({
      name: 'embersynth.route.simulate',
      arguments: {} as unknown as Record<string, unknown>,
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  test('reload with wrong `dryRun` type is an MCP error', async () => {
    // reload has no required fields (dryRun defaults to false), so
    // probe schema enforcement by feeding the wrong type.
    const client = await connected();
    const result = (await client.callTool({
      name: 'embersynth.reload',
      arguments: { dryRun: 'not-a-bool' } as unknown as Record<string, unknown>,
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

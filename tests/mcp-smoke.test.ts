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
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'embersynth-mcp-runtime-'));
  auditDir = mkdtempSync(join(tmpdir(), 'embersynth-mcp-audit-'));
  configPath = join(runtimeDir, 'embersynth.yaml');
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
        { id: 'private-first', label: 'Private First', preferredTags: ['private'] },
      ],
      syntheticModels: {
        'fusion-auto': 'auto',
        'fusion-private-first': 'private-first',
      },
    }),
  );
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    LLAMACTL_MCP_AUDIT_DIR: auditDir,
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
      'embersynth.nodes.list',
      'embersynth.profiles.list',
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

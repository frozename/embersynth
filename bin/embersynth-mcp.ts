#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildEmbersynthMcpServer } from '../src/mcp/index.js';

/**
 * Stdio MCP server entry for embersynth. Claude Code, Claude Desktop,
 * and other clients spawn this as a subprocess and speak JSON-RPC
 * over stdin/stdout. Diagnostics go to stderr (stdout carries the
 * protocol).
 */

async function main(): Promise<void> {
  const server = buildEmbersynthMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('embersynth-mcp: ready (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`embersynth-mcp: fatal ${(err as Error).message}\n`);
  process.exit(1);
});

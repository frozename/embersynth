# GEMINI.md — embersynth

Gemini CLI entrypoint. Defers to [`AGENTS.md`](./AGENTS.md) as the
authoritative source; this file calls out Gemini-specific nudges.

## Before any task

1. Read `AGENTS.md` (full rules, router semantics, capability /
   profile / synthetic-model model).
2. Read `README.md` for config reference + streaming semantics.
3. If the task touches the classifier / planner / executor
   boundary, write a plan doc before coding — those interactions
   are the most fragile part of the runtime.

## Non-negotiables

- **Capability-based routing, not name-based.** The classifier
  says "I need `reasoning`"; the planner picks a node with that
  capability; the executor runs it. Never hard-code model IDs in
  the router.
- **OpenAI-compat adapter delegates to Nova.** Bug fixes in
  wire-format handling land in `@nova/contracts`, not in
  `src/adapters/openai-compatible.ts`.
- **Streaming contract:**
  - Intermediate stages run buffered.
  - Final stage streams via SSE if `stream: true`.
  - Non-streaming final-stage adapter → one SSE chunk with full
    buffered response.
  - Don't break this.
- **Config validates on load.** Fail loud with a clear error on
  missing capabilities, undefined tags, undefined profiles.
- **Bun** only. **English** identifiers. **TypeScript strict**.

## Runtime + commands

```bash
bun install
bun run dev                        # hot reload
bun run start                      # production
bun run test
bun run typecheck

bun run cli:status
bun run cli:check
bun run cli:test-node -- <node-id>
bun run cli:nodes
bun run cli:profiles

bun src/mcp/bin/embersynth-mcp.ts  # MCP server
```

## Cross-repo

Depends on Nova. After a Nova bump:
```bash
bun install
bun test
bun run typecheck
```
Baseline: embersynth ≥ 129 tests.

## Where to look

- `src/router/` — classifier, planner, executor.
- `src/adapters/openai-compatible.ts` — Nova delegation.
- `src/registry/` — node registry with capability filtering.
- `src/evidence/` — compression for multi-stage pipelines.
- `src/mcp/` — MCP server.
- `config/examples/` — reference YAML configs.

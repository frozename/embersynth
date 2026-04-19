# JULES.md — embersynth

Jules (Google's async coding agent) entrypoint. Defers to
[`AGENTS.md`](./AGENTS.md) as the authoritative source.

Jules runs in a cloud VM and produces a PR. Tasks come from GitHub
issues; output is one focused commit.

## Before opening a PR

1. Read `AGENTS.md` at the repo root.
2. Identify the layer the issue touches:
   - `src/api/` — HTTP surface.
   - `src/adapters/` — provider adapter code (but Nova delegation
     for OpenAI-compat — fix there, not here).
   - `src/router/` — classifier, planner, executor.
   - `src/registry/` — node registry.
   - `src/evidence/` — compression.
   - `src/mcp/` — MCP server.
3. Verify baseline green:
   ```bash
   bun install && bun test && bun run typecheck
   ```

## Scope rules

- **One slice per PR.**
- **Preserve the classifier → planner → executor pipeline.** Don't
  blur those layers without a design doc attached to the issue.
- **OpenAI-compat adapter bugs → Nova.** If the root cause is in
  the wire-format parser, fix in `@nova/contracts`, not here.
- **Cross-repo sync is the user's responsibility.**

## Non-negotiables

- **TypeScript strict** — no `any`.
- **Capability-based routing.** No hardcoded model IDs in the
  router.
- **Streaming contract** (intermediate stages buffered, final
  stage SSE, non-streaming adapter → one buffered SSE chunk). Don't
  break it.
- **Config validates on load.** Fail loud.
- **Bun** only.
- **English** identifiers.
- **No tool / AI attribution** in commits.

## PR body checklist

- Problem (link to issue).
- Approach (2-4 sentences).
- Test deltas.
- Profile / capability changes, if any. Config YAML changes must
  be mirrored in `tests/fixtures/` and relevant router tests.
- Cross-repo impact: Nova bump needed?

## Commands

```bash
bun install
bun test
bun run typecheck
bun run dev        # local verification
```

## Layout cheatsheet

```
src/api/          HTTP routes
src/adapters/     openai-compatible (Nova-delegated), generic-http
src/router/       classifier / planner / executor
src/registry/     node registry
src/evidence/     compression
src/health/       health monitor
src/logger/       structured logging
src/mcp/          MCP server
src/cli/          CLI tools
```

# GitHub Copilot Instructions — embersynth

Condensed digest. Authoritative rules live in [`AGENTS.md`](../AGENTS.md).

## What this repo is

Local-first distributed AI orchestration runtime. Clients hit one
OpenAI-compatible endpoint with synthetic model IDs
(`fusion-auto`, `fusion-vision`, `fusion-private`); embersynth
classifies the request, plans a multi-stage pipeline across local
nodes, executes, and synthesizes the final response.

Capability-based routing (not name-based). A "node" has
capabilities (`reasoning`, `vision`, `retrieval`, …); a "profile"
maps routing constraints to a synthetic model; the "classifier"
determines capability requirements per request.

## Stack

- Bun 1.3+, TypeScript 5.7+ strict.
- Zod 4 for config + request shapes.
- YAML for config (`embersynth.yaml`).
- `@nova/contracts` + `@nova/mcp-shared` via `file:` deps.

## Layout

```
src/api/            HTTP + routes
src/adapters/       openai-compatible (Nova delegation),
                     generic-http
src/cli/            status / check-config / test-node / list-* tools
src/config/         YAML loader + env interpolation
src/evidence/       multi-stage evidence compression
src/health/         health monitoring
src/logger/         structured JSON logging
src/mcp/            @embersynth/mcp stdio server
src/registry/       node registry (capability/tag/health filtering)
src/router/         classifier + planner + executor + streaming
src/tracing/        request-scoped tracing
src/types/          all TS interfaces
```

## Hard rules

- **Capability-based routing.** Never hardcode model IDs in
  `src/router/`.
- **OpenAI-compat bugs → Nova.** `src/adapters/openai-compatible.ts`
  delegates to `@nova/contracts`'s `createOpenAICompatProvider`.
  Fix wire issues upstream.
- **Streaming contract:**
  - Intermediate stages buffered.
  - Final stage streams via SSE when `stream: true`.
  - Non-streaming adapter → single SSE chunk with full response.
- **Config validates on load.** Fail loud on missing capabilities,
  undefined tags, undefined profiles.
- **TypeScript strict.** No `any`.
- **Bun** only.
- **English** identifiers.
- **No comments explaining WHAT** — only WHY.
- **No AI / tool attribution** in commits.

## Tests

- `bun:test`. Fixtures under `tests/fixtures/`.
- Adapter tests stub `fetch`.
- Router tests construct a fake registry with canned health.

## Cross-repo

Depends on Nova. After a Nova bump:
```bash
bun install && bun test && bun run typecheck
```
Baseline: embersynth ≥ 129 tests.

## Key references

- `AGENTS.md` — full rules.
- `README.md` — overview, config reference, streaming notes.
- `config/examples/` — reference configs.

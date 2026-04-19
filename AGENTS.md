# AGENTS.md — embersynth

Agent instructions for any AI coding tool (Claude Code, Cursor,
Codex, Copilot, Gemini, Jules) working in this repo. See `README.md`
for the user-facing overview.

## What this repo is

Local-first distributed AI orchestration runtime. Exposes multiple
heterogeneous local AI/model/service nodes as a single virtual model
API. Clients hit one OpenAI-compatible endpoint; embersynth
classifies the request, plans a multi-stage pipeline across nodes
(memory → retrieval → vision → reasoning), collects structured
evidence, compresses it, and synthesizes a final response.

Capability-based routing, not name-based. Clients say
`"model": "fusion-auto"` — embersynth picks the right node at each
stage.

## Tech stack

- **Runtime**: Bun 1.3+.
- **Framework**: None (Bun's built-in HTTP + custom routing).
- **Language**: TypeScript 5.7+, strict, `"type": "module"`.
- **Validation**: Zod 4 (for config + request shapes).
- **Config**: YAML (`embersynth.yaml`, searched in precedence).
- **Nova**: `@nova/contracts` + `@nova/mcp-shared` via `file:`.

## Layout

```
src/
├── api/              HTTP server + route handlers (completions,
│                     embeddings, responses, metrics, health)
├── adapters/         Provider adapters. openai-compatible.ts
│                     delegates to @nova/contracts'
│                     createOpenAICompatProvider; generic-http.ts
│                     is the fallback for `/generate`-shape services.
├── cli/              CLI tools (status, check-config, test-node,
│                     list-nodes, list-profiles)
├── config/           Config loading, defaults, env var interpolation
├── evidence/         Evidence compression for multi-stage pipelines
├── health/           Health monitoring
├── logger/           Structured JSON logging, request tracing
├── mcp/              @embersynth/mcp stdio MCP server
├── registry/         Node registry with capability/tag/health filtering
├── router/           Classifier, planner, executor. Streaming +
│                     dynamic re-routing on failure live here.
├── tracing/          Request-scoped tracing glue
└── types/            All TypeScript interfaces
```

## Commands

```bash
bun install
bun run dev                    # hot reload
bun run start                  # production
bun run test
bun run typecheck

# CLI tools
bun run cli:status
bun run cli:check
bun run cli:test-node -- <node-id>
bun run cli:nodes
bun run cli:profiles

# MCP server
bun src/mcp/bin/embersynth-mcp.ts
```

## Core concepts (keep in mind while editing)

| Concept | Meaning |
|---|---|
| **Node** | A service endpoint with capabilities, tags, and metadata. |
| **Capability** | What a node can do: `reasoning`, `vision`, `embedding`, `retrieval`, `memory`, etc. |
| **Profile** | Routing constraints (required tags, max stages, synthesis-required) mapped to synthetic model IDs. |
| **Synthetic model** | A virtual model ID (`fusion-auto`, `fusion-vision`, `fusion-private`) that triggers a routing profile. |
| **Execution plan** | A sequence of stages the router builds for a request. |
| **Evidence bundle** | Structured output from intermediate stages, fed into final synthesis. |

**Don't break these boundaries.** Classifier produces capability
requirements; planner picks nodes; executor runs them. A change that
blurs any of those lines deserves a plan doc first.

## Code style

- **TypeScript strict**; no `any`. Interfaces for all cross-module
  contracts.
- **No comments explaining WHAT.** Comments for WHY — subtle
  constraints, non-obvious decisions, workarounds.
- **Module headers** — one paragraph orienting the reader is fine.
- **Structured logging.** Use the `logger/` module; never
  `console.log` in runtime code (test files OK).
- **Bun idioms.** `Bun.file`, `Bun.spawn`, `Bun.serve` where they
  match; `node:*` imports are fine for parity with TS ecosystems.

## Adapter pattern

OpenAI-compatible adapter is thin — it delegates to Nova:

```ts
import { createOpenAICompatProvider } from '@nova/contracts';

const provider = createOpenAICompatProvider({
  name: node.id,
  baseUrl: node.endpoint,
  apiKeyRef: node.config?.apiKey,
  healthPath: node.config?.healthPath,
});
```

**When you find a bug in OpenAI-compat wire handling, fix it in Nova**,
not in `src/adapters/openai-compatible.ts`. The adapter here is just
a bridge to embersynth's `ProviderAdapter` interface. Downstream
consumers (sirius, llamactl) benefit from the same fix automatically.

To add a new adapter dialect, implement `ProviderAdapter` in
`src/adapters/<name>.ts` + `registerAdapter()` in
`src/adapters/index.ts`. Health check + auth + timeout are part of
the interface.

## Testing

- `bun:test` throughout.
- **Fixtures** under `tests/fixtures/` — YAML configs for node
  registry setups.
- **Adapter tests** stub `fetch` — don't hit upstreams.
- **Router tests** construct a fake registry with canned health and
  assert planning + execution shape.
- **Evidence compression tests** use deterministic inputs; no LLM
  calls.

## Config discipline

- Config file lookup order: `./embersynth.yaml`, `$EMBERSYNTH_CONFIG`,
  `~/.llamactl/embersynth.yaml` (when running in the llamactl family).
- Env var interpolation supported via `${VAR_NAME}` in YAML.
- **Validate on load.** Fail loud with a clear error if a node
  references a missing capability, a profile references an unknown
  tag, or a synthetic model maps to an undefined profile.
- **Atomic hot reload** lives in `src/config/reload.ts`
  (`reloadConfigFromDisk`). Both the `ConfigWatcher` (fs.watch) and
  the `POST /config/reload` endpoint go through this single helper
  so the two reload paths stay coherent. On rollback the previous
  registry + health snapshot are restored — the server keeps
  serving the last-good config rather than entering a
  half-configured state.

## Reload endpoint contract (cross-repo)

`POST /config/reload` is what the llamactl sirius+embersynth gateway
workload handler calls after an upstream edit:

```
POST /config/reload
Authorization: Bearer <kubeconfig user token>
Content-Type:  application/json
Body:          {"source":"llamactl-workload","name":"<workload-name>",
                "syntheticModel":"fusion-<id>"}

200 → {ok:true, added:[...], removed:[...], nodesBefore, nodesAfter, ...}
500 → {ok:false, error:"...", ...} — llamactl surfaces as Failed + EmbersynthReloadFailed
503 → {ok:false} — returned when onReload isn't wired (inline config)
```

Keep this shape stable. Llamactl's gateway handler parses the
response body for audit logging; breaking the shape without a
coordinated bump on the llamactl side will silently drop telemetry.

## Streaming

- Intermediate stages always run buffered (they need full evidence
  before passing down).
- Final stage streams via SSE if the client sets `stream: true`.
- If the final node's adapter doesn't support streaming, fall back
  to a single SSE chunk carrying the full buffered response.
- Responses API streaming wraps SSE in Responses event format.

Don't break this contract. Streaming semantics are the most
fragile part of the router.

## MCP server (`@embersynth/mcp`)

Projects operator surface (node health, profile listing, config
status, synthetic-model mappings) as stdio MCP tools. Audit records
go through `@nova/mcp-shared`'s `appendAudit` so entries interop
with llamactl + sirius.

## Cross-repo discipline

Depends on Nova. After a Nova schema change or adapter fix:

```bash
bun install      # refresh file: lockfile
bun test         # must stay green
bun run typecheck
```

If the change touches the `AiProvider` contract, lift into
`@nova/contracts` first, bump, then sync here + sirius + llamactl
in one round.

Baseline: embersynth ≥ 129 tests green.

## What to avoid

- Writing OpenAI-compat wire logic in this repo. Delegate to Nova.
- Routing by model name instead of capability. That's a regression
  to a brittle lookup.
- Hard-coding a specific upstream shape into the router. The router
  knows about nodes + capabilities + profiles; it doesn't know
  whether a node is Ollama or vLLM.
- Profile edits without a test case in `tests/profiles.test.ts`.
- Portuguese / non-English identifiers. English throughout.

## Design principles (inherited from README)

- **Local-first.** No cloud dependencies. Runs on localhost, LAN,
  or tunneled services.
- **Topology-agnostic.** Add, remove, move nodes by config. No code
  changes.
- **Capability-driven.** Route by what nodes do, not where they are.
- **Config-driven.** Nodes, profiles, policies — all in YAML.
- **Graceful degradation.** Unhealthy nodes skipped with fallback.
- **Observable.** Structured JSON logs, `/metrics` endpoint, CLI
  health tools.

## Key references

- `README.md` — overview, config reference, examples.
- `config/examples/` — reference YAML configs.
- `../nova/AGENTS.md` — Nova SDK rules.

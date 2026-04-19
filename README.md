# EmberSynth

Local-first distributed AI orchestration runtime. Exposes multiple heterogeneous AI/model/service nodes as a single virtual model API.

## What it does

EmberSynth sits between your clients and your local AI services. Clients call one endpoint as if it were a single model. Internally, EmberSynth:

1. **Inspects** the request to determine what capabilities are needed
2. **Plans** a multi-stage execution pipeline across available nodes
3. **Routes** work to the right nodes based on capabilities, health, and policy
4. **Collects** structured evidence from intermediate stages
5. **Compresses** evidence when configured to reduce token usage
6. **Synthesizes** a final unified response (streamed or buffered)

```text
Client ──► EmberSynth ──► Memory Node ──► Retrieval Node ──► Vision Node ──► Reasoning Node
                │                                                                │
                │         ◄── evidence (compressed) ────────────────────────────┘
                │
                ◄─── unified response (streamed SSE) ──────────────────────────┘
```

## Architecture

```text
src/
├── api/            # HTTP server, route handlers (completions, embeddings, responses, metrics)
├── adapters/       # Provider adapters (OpenAI-compatible via @nova/contracts, generic HTTP)
├── cli/            # CLI tools (status, check-config, test-node, list-nodes, list-profiles)
├── config/         # Config loading, defaults, env var interpolation
├── evidence/       # Evidence compression for multi-stage pipelines
├── health/         # Health monitoring
├── logger/         # Structured JSON logging with request tracing
├── mcp/            # @embersynth/mcp — stdio MCP server projecting ops surface as tools
├── registry/       # Node registry with capability/tag/health filtering
├── router/         # Request classifier, planner, executor (with streaming + dynamic re-routing)
└── types/          # All TypeScript interfaces
```

### Core concepts

| Concept | Description |
|---------|-------------|
| **Node** | A service endpoint with capabilities, tags, and metadata |
| **Capability** | What a node can do: `reasoning`, `vision`, `embedding`, `retrieval`, `memory`, etc. |
| **Profile** | Routing constraints mapped to synthetic model IDs |
| **Synthetic model** | A virtual model ID (`fusion-auto`) that triggers a routing profile |
| **Execution plan** | A sequence of stages the router builds for a request |
| **Evidence bundle** | Structured output from intermediate stages, fed into final synthesis |

### Request flow

```text
Request → Classifier → Planner → Executor → Response
              │            │          │
              │            │          ├── Stage 1 (e.g. memory recall)
              │            │          ├── Stage 2 (e.g. retrieval)
              │            │          ├── Stage 3 (e.g. vision analysis)
              │            │          ├── Stage 4 (e.g. reasoning synthesis) [streamed]
              │            │          └── Dynamic fallback on failure
              │            │
              │            └── Select nodes by capability + health + tags + priority
              │
              └── Detect: vision? retrieval need? memory need? complexity?
```

## API

### GET /v1/models

Lists available synthetic models.

```bash
curl http://localhost:7777/v1/models
```

### POST /v1/chat/completions

OpenAI-compatible chat completions with optional streaming.

**Text request:**

```bash
curl http://localhost:7777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fusion-auto",
    "messages": [{"role": "user", "content": "Explain quantum computing"}]
  }'
```

**Streaming request:**

```bash
curl http://localhost:7777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fusion-auto",
    "messages": [{"role": "user", "content": "Write a poem"}],
    "stream": true
  }'
```

**Vision request (multi-stage pipeline):**

```bash
curl http://localhost:7777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fusion-vision",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "What is in this image?"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
      ]
    }]
  }'
```

**Private-only request:**

```bash
curl http://localhost:7777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fusion-private",
    "messages": [{"role": "user", "content": "Analyze this sensitive document"}]
  }'
```

### POST /v1/embeddings

Route embedding requests to embedding-capable nodes.

```bash
curl http://localhost:7777/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fusion-auto",
    "input": "The quick brown fox"
  }'
```

### POST /v1/responses

OpenAI Responses API format — translated internally to chat completions.

```bash
curl http://localhost:7777/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fusion-auto",
    "input": "Explain embeddings in one sentence",
    "instructions": "Be concise"
  }'
```

Streaming is also supported with `"stream": true`.

### GET /metrics

Detailed system metrics including node health, latency, and capability coverage.

```bash
curl http://localhost:7777/metrics
```

### GET /health

Basic health check.

### POST /config/reload

Atomic hot reload of `embersynth.yaml`. Re-reads the resolved config
path, rebuilds the `NodeRegistry`, starts a fresh `HealthMonitor`,
and swaps in the new state. On failure the previous registry + health
state are restored so the server keeps serving with the last-known-good
config.

Wired at launch when a config file is resolvable (stdin / inline config
omits the handler — POST returns `503`). Used by the `llamactl` sirius
+ embersynth workload handlers (see K.7 on the llamactl side) to push
a reload after an upstream edit lands.

Response (200):

```json
{
  "ok": true,
  "configPath": "/path/to/embersynth.yaml",
  "nodesBefore": 3,
  "nodesAfter": 3,
  "profilesBefore": 4,
  "profilesAfter": 4,
  "added": ["node-new"],
  "removed": ["node-retired"],
  "timestamp": "2026-04-19T21:56:48.928Z"
}
```

Rejection (500 + `ok:false`) on YAML parse error or registry mutation
failure with the error message in the payload. The `fs.watch`-based
`ConfigWatcher` path (`EMBERSYNTH_WATCH=true` or `config.server.watch:
true`) goes through the same helper, so a reload triggered by an
operator editing the file behaves identically to a POST.

### Response headers

Every completion response includes orchestration metadata:

| Header | Description |
|--------|-------------|
| `X-EmberSynth-Plan-Id` | Unique execution plan ID |
| `X-EmberSynth-Stages` | Number of pipeline stages executed |
| `X-EmberSynth-Profile` | Which routing profile was used |
| `X-EmberSynth-Duration-Ms` | Total orchestration time |

## Config model

All nodes, profiles, and policies are defined in YAML with env var interpolation.

### Config file locations (searched in order)

1. `./embersynth.yaml`
2. `./embersynth.yml`
3. `./config/embersynth.yaml`
4. `./config/embersynth.yml`
5. Custom path via CLI: `bun run src/index.ts /path/to/config.yaml`

### Environment variables

| Variable | Description |
|----------|-------------|
| `EMBERSYNTH_HOST` | Override server bind address |
| `EMBERSYNTH_PORT` | Override server port |
| `EMBERSYNTH_LOG_LEVEL` | Log level: `debug`, `info`, `warn`, `error` |
| `${VAR_NAME}` in YAML | Interpolated from environment |
| `${VAR_NAME:-default}` | With fallback value |

### Node definition

```yaml
nodes:
  - id: reasoning-primary
    label: "Local Reasoning"
    endpoint: "http://localhost:8080"
    transport: http
    enabled: true
    capabilities: [reasoning]
    tags: [local, private]
    providerType: openai-compatible
    modelId: "llama3"
    priority: 1                    # lower = preferred
    auth:
      type: none                   # none | bearer | header
    health:
      endpoint: /health
      intervalMs: 30000
      timeoutMs: 5000
      unhealthyAfter: 3
    timeout:
      requestMs: 120000
    optimization:                  # optional hints
      quantization: "Q4_K_M"
      contextWindow: 8192
```

### Profiles

```yaml
profiles:
  - id: auto
    label: "Automatic"
    preferLowerPriority: true

  - id: fast
    label: "Fast"
    maxStages: 1

  - id: private
    label: "Private"
    requiredTags: [private]

  - id: vision
    label: "Vision"
    synthesisRequired: true
```

### Policy

```yaml
policy:
  fallbackEnabled: true          # try alternate nodes on failure
  maxRetries: 2                  # retries per node before fallback
  retryDelayMs: 500
  requireHealthy: true
  evidenceCompression: true      # compress evidence between stages
  evidenceMaxLength: 4000        # max chars per evidence item
```

### Synthetic model mapping

```yaml
syntheticModels:

  fusion-auto: auto
  fusion-fast: fast
  fusion-private: private
  fusion-vision: vision
```

## Running locally

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- One or more local AI services (Ollama, llama.cpp server, vLLM, etc.)

### Setup

```bash
bun install

cp config/embersynth.example.yaml embersynth.yaml
# Edit embersynth.yaml to match your local services

bun run dev    # with hot reload
bun run start  # production
```

### Running tests

```bash
bun test
```

## CLI tools

```bash
# Show node health and connectivity
bun run cli:status

# Validate config file
bun run cli:check

# Test a specific node
bun run cli:test-node -- reasoning-primary

# List all nodes
bun run cli:nodes

# List all profiles
bun run cli:profiles
```

Or directly:

```bash
bun run src/cli/index.ts status --config ./embersynth.yaml
bun run src/cli/index.ts test-node reasoning-primary
```

## How profiles work

When a client sends `"model": "fusion-private"`:

1. EmberSynth maps `fusion-private` → profile `private`
2. The `private` profile has `requiredTags: [private]`
3. The classifier determines needed capabilities (e.g. `reasoning`)
4. The planner finds nodes with `reasoning` capability AND `private` tag
5. If no nodes match → returns HTTP 503 with clear error
6. If nodes match → builds plan, executes, returns response

**fusion-fast** sets `maxStages: 1` — skips intermediate stages, routes directly to reasoning.

**fusion-vision** sets `synthesisRequired: true` — always runs final synthesis even for single-stage pipelines.

## Intelligent request classification

The classifier detects:
- **Vision content**: image URLs, base64 data, multipart content
- **Retrieval needs**: keywords like "search", "knowledge base", "according to"
- **Memory needs**: "remember", "previously", "last time", "we discussed"
- **Complexity**: message length and conversation depth

Based on detection, it builds a pipeline: `memory → retrieval → vision → reasoning`

Profiles can limit pipeline depth (e.g. `maxStages: 1` skips intermediate stages).

## Dynamic re-routing

If a node fails during execution:

1. The executor retries up to `maxRetries` times
2. On exhaustion, marks the node unhealthy
3. If `fallbackEnabled`, finds alternate nodes with the same capability
4. Respects profile constraints (tags, health) during fallback
5. Continues the pipeline with the fallback node

## Streaming

When `stream: true`:
- Intermediate stages execute normally (need full evidence)
- The final stage streams via SSE
- If the final node's adapter doesn't support streaming, falls back to buffered response delivered as a single SSE chunk
- Responses API streaming wraps SSE in Responses API event format

## Evidence compression

When `evidenceCompression: true` in policy:
- Evidence from intermediate stages is compressed before passing to the next stage
- Preserves key sentences from the beginning and end of content
- Reduces token usage in synthesis stage
- Configurable via `evidenceMaxLength`

## Example configs

- `config/examples/single-node.yaml` — minimal single-model setup
- `config/examples/multi-node.yaml` — multiple nodes with LAN fallback
- `config/examples/private-only.yaml` — air-gapped private deployment
- `config/examples/vision-pipeline.yaml` — vision → reasoning pipeline

## Provider adapters

| Adapter | Key | Compatible with |
|---------|-----|-----------------|
| OpenAI-compatible | `openai-compatible` | Ollama, llama.cpp, vLLM, LocalAI, LM Studio — implementation delegates to `@nova/contracts`'s `createOpenAICompatProvider`. Chat, embeddings, streaming events, tool-call deltas share a single wire path across the llamactl / sirius / embersynth family. |
| Generic HTTP | `generic-http` | Custom services with `/generate` endpoint |

Both adapters support health checking, auth, timeouts, and the embedding interface.

To add a new adapter, implement the `ProviderAdapter` interface and call `registerAdapter()`.

## MCP server

EmberSynth ships an `@embersynth/mcp` stdio server that projects its
operator surface — node health, profile listing, config status,
synthetic-model mappings — as MCP tools. Wire into Claude Desktop or
any MCP client:

```bash
bun src/mcp/bin/embersynth-mcp.ts
```

See `src/mcp/server.ts` for the tool surface. Audit + content
envelopes reuse `@nova/mcp-shared` so the records interoperate with
llamactl and sirius audit trails.

## Family

Part of the llamactl family:

- [nova](../nova/) — canonical AI-provider contracts + cross-cutting
  MCP helpers (`@nova/contracts`, `@nova/mcp-shared`, `@nova/mcp`).
  EmberSynth's OpenAI-compat adapter delegates to Nova's provider
  factory; adapter fixes in one place benefit every consumer.
- [llamactl](../llamactl/) — single-operator control plane for
  llama.cpp fleets (kubeconfig, workloads, infra deploy).
- [sirius-gateway](../sirius-gateway/) — unified gateway for
  multiple external AI providers (OpenAI, Anthropic, …).

## Design principles

- **Local-first**: No cloud dependencies. Runs on localhost, LAN, or tunneled services.
- **Topology-agnostic**: Add, remove, or move nodes by config — no code changes.
- **Capability-driven**: Route by what nodes can do, not where they are.
- **Config-driven**: Nodes, profiles, policies — all in YAML.
- **Graceful degradation**: Unhealthy nodes are skipped with automatic fallback.
- **Observable**: Structured JSON logging, metrics endpoint, CLI health tools.

## License

MIT — see [`LICENSE`](./LICENSE).

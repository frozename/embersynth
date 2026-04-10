# Fix Codex Review Findings

## Context

Codex reviewed 12 files of uncommitted changes (Gemini's implementation of the 5-phase code quality plan plus bonus improvements). The review found 1 critical, 5 important, and 2 minor issues. This plan fixes all of them.

## Phase 0: Documentation Discovery

### Allowed APIs / Patterns
- `Bun.serve()` returns a `Server` with `.stop()` — binding the same port while the old server is alive will throw
- `NodeRegistry.load(nodes)` calls `this.nodes.clear()` then `.set()` for each node (last-wins semantics) — `registry.ts:13-31`
- `AdapterResponse` has optional `toolCalls?: ToolCall[]` field — `types/index.ts:176`
- `ChatCompletionRequest` has typed `tools` and `tool_choice` fields — `types/index.ts:254-255`
- `ToolCallDelta` is properly typed — `types/tools.ts:22-30`
- `ToolCall` is properly typed — `types/tools.ts:7-14`
- `interpolateEnv()` returns `''` for unset env vars with no fallback — `config/loader.ts:23-28`

### Anti-patterns
- Do NOT use `Number(x) || fallback` — the original bug that `num()` was meant to fix
- Do NOT call `registry.load()` before validating the rest of the reload succeeds
- Do NOT silently discard errors in fallback loops — preserve last error for diagnostics

---

## Phase 1: Fix Hot-Reload Race Condition

**Files:** `src/index.ts` (lines 45-68)

**What to fix:** `registry.load(newConfig.nodes)` is called at line 47 before the try-catch block. If `createServer()` or `new HealthMonitor()` throws, the registry is already corrupted with new nodes while the old server/policy remains active.

**Implementation:**
1. Move `registry.load(newConfig.nodes)` inside the try block, after `createServer()` and `new HealthMonitor()` succeed
2. Sequence: create new monitor -> create new server -> stop old monitor -> stop old server -> load new nodes into registry -> start new monitor -> assign new references

**But there's a port conflict:** `createServer()` calls `Bun.serve()` which binds immediately. If host/port haven't changed, this will fail because the old server still holds the port.

**Revised approach:** Since Bun doesn't support deferred binding, and config reloads primarily change nodes/profiles (not host/port):
1. Move `registry.load()` inside the try block but keep it as the first operation there
2. On catch, restore the old nodes by calling `registry.load(config.nodes)` (where `config` is captured before the callback)
3. This makes the operation recoverable rather than atomic

**Verification:** `bun test` passes. Manual test: corrupt a config reload and verify the old nodes remain active.

---

## Phase 2: Fix Config Loader Issues

**Files:** `src/config/loader.ts`

### 2a: Fix `num()` empty-string edge case (lines 9-13)

`Number('')` returns `0`, not `NaN`. When `interpolateEnv()` returns `''` for unset vars, `num()` will produce `0` instead of the fallback.

**Fix:** Add empty/whitespace check before `Number()`:
```typescript
function num(raw: unknown, fallback: number): number {
  if (raw == null) return fallback;
  if (typeof raw === 'string' && raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isNaN(n) ? fallback : n;
}
```

### 2b: Fix duplicate node warning text (line 105)

Warning says "later definition will overwrite" but the dedup filter at line 190 keeps the **first** occurrence. The warning is misleading.

**Fix:** Change warning to: `Duplicate node ID: "${node.id}" — later definition will be dropped`

**Verification:** `bun test` passes. Grep for "will overwrite" returns no results.

---

## Phase 3: Fix Streaming Fallback Gap

**Files:** `src/router/index.ts` (lines 186-268), `src/router/executor.ts` (lines 212-213)

**Problem:** If a streaming-capable alternate exists but fails at runtime, `executePlanStreaming()` throws "No streaming-capable node available" (line 212) and `routeStreaming()` propagates it as a 500. The non-streaming SSE conversion path (lines 206-266) is only entered when no streaming-capable node exists at all.

**Fix in `routeStreaming()`:** Wrap the `executePlanStreaming()` call in a try-catch. If it fails with the streaming-unavailable error, fall through to the non-streaming SSE conversion path (call `route()` and convert to SSE chunks).

**Implementation:**
1. Extract the non-streaming-to-SSE conversion logic (lines 206-266) into a helper function: `async function fallbackToNonStreaming(request, config, registry)`
2. Call this helper both in the `!hasStreamingAlternate` branch AND in the catch block when streaming execution fails
3. This avoids code duplication while ensuring the fallback is always available

**Verification:** `bun test` passes. The streaming path gracefully degrades when streaming nodes fail.

---

## Phase 4: Fix Embedding Error Handling

**Files:** `src/router/index.ts` (lines 348-372)

**Problem:** The fallback loop collapses all failures into "502 All embedding nodes failed". Adapters without `sendEmbeddingRequest` are silently skipped. Last error message is lost.

**Fix:**
1. Track `let lastError: string | undefined` and `let hasEmbeddingAdapter = false` before the loop
2. Inside the loop, when `adapter?.sendEmbeddingRequest` exists, set `hasEmbeddingAdapter = true`
3. In catch blocks, capture `lastError = err.message`
4. After the loop:
   - If `!hasEmbeddingAdapter`: return 501 "No adapter supports embeddings for the available nodes"
   - Else: return 502 with `lastError` or "All embedding nodes failed"

**Verification:** `bun test` passes. A node with a non-embedding adapter returns 501 instead of 502.

---

## Phase 5: Fix Generic HTTP Tool Response Parsing

**Files:** `src/adapters/generic-http.ts` (lines 77-85)

**Problem:** The adapter now forwards `tools`/`tool_choice` in requests (lines 55-57) but never parses `toolCalls` from the response. If the backend returns tool calls, they're silently dropped.

**Fix:** Extend the response JSON shape to include tool calls and populate `AdapterResponse.toolCalls`:
```typescript
const data = (await response.json()) as {
  content?: string;
  finish_reason?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
};

return {
  content: data.content ?? '',
  finishReason: data.finish_reason ?? 'stop',
  toolCalls: data.tool_calls?.length ? data.tool_calls : undefined,
};
```

**Verification:** `bun test` passes. Type check confirms `toolCalls` matches `AdapterResponse.toolCalls`.

---

## Phase 6: Minor Fixes

### 6a: Fix error `detail` string for non-capability-gap errors

**Files:** `src/router/index.ts` (lines 78-83, lines 171-176)

The `detail` field always says "No available node for capability..." even for errors from `maxStages` limits.

**Fix:** Build `detail` conditionally:
```typescript
const detail = planResult.error.type === 'capability-gap'
  ? `No available node for capability "${planResult.error.capability}" under profile "${profile.id}"`
  : planResult.error.message;
```

Apply in both `route()` (line 81) and `routeStreaming()` (line 174).

### 6b: Replace `any` types with proper types

**Files:**
- `src/router/executor.ts` line 101: `tools?: any[]; toolChoice?: any` -> use `ChatCompletionRequest['tools']` and `ChatCompletionRequest['tool_choice']`
- `src/adapters/openai-compatible.ts` line 191: `tool_calls?: any[]` -> use `ToolCallDelta[]` (import from `types/tools.js`)

### 6c: Remove trailing blank line

**Files:** `src/router/executor.ts` — trailing blank line at end of file (line 511)

**Verification:** `bun test` passes. `bun run typecheck` passes. `grep -rn 'any\[\]' src/` shows no tool-related `any` types.

---

## Files Modified

| File | Phases |
|------|--------|
| `src/index.ts` | 1 |
| `src/config/loader.ts` | 2 |
| `src/router/index.ts` | 3, 4, 6a |
| `src/router/executor.ts` | 3, 6b, 6c |
| `src/adapters/generic-http.ts` | 5 |
| `src/adapters/openai-compatible.ts` | 6b |

## Final Verification

After all phases: `bun test` and `bun run typecheck` must pass.

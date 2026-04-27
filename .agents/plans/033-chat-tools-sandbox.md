# Plan: Chat Tools Sandbox

Date: 2026-04-10

## Goal

Give the chat agent a single high-leverage `runCode` tool that runs
model-authored TypeScript inside a QuickJS WASM sandbox, where the only
side-effects available are typed calls back into the existing
`workspace-function-registry`. This lets the model orchestrate
multi-step workspace queries (filter, join, summarise) in one tool call
instead of paying a tool round-trip per step, while keeping execution
isolated from the host process.

## Design Decisions

- **Engine: `quickjs-emscripten` on the quickjs-ng asyncify variant.**
  We pick `@jitl/quickjs-ng-wasmfile-release-asyncify` and the
  `quickjs-emscripten` umbrella, not `@sebastianwessel/quickjs`. Stella
  is security-sensitive; we want the smallest possible surface and a
  Stella-owned bridge instead of a general-purpose sandbox product
  shipping `fetch`, memfs, Node shims, and module loading. Thin
  integration = clearer audit, capability control, and budgets.
- **Async variant, not sync.** The host functions in
  `workspace-function-registry` (DB queries, search) are inherently
  async. Asyncify is the only realistic option; the perf overhead is
  irrelevant next to DB/search latency.
- **Bun transpiles model TypeScript before execution.** We use
  `Bun.Transpiler` (target: browser, no JSX) to strip types and
  produce JS that QuickJS can run. Bun is **only** used for
  transpilation, never for sandboxing.
- **One bridge function, not many globals.** The sandbox sees a single
  global `__stellaCall(name, argsJson)` (or a thin generated wrapper
  exposing `stella.searchContent(...)` etc.). The bridge serialises
  args to JSON, calls the registry's `execute(input)`, awaits, and
  returns JSON back. Validation happens **outside** the sandbox via the
  existing Valibot input/output schemas in `createToolFunction`. The
  sandbox is untrusted; validation must always run on the host.
- **No host objects, only JSON.** Arguments and return values cross
  the boundary as serialised JSON strings to keep the marshalling
  surface trivially auditable. The bridge never hands raw host
  references into the VM.
- **Capability split via the registry the caller passes in.** The
  sandbox runner takes any `Record<string, ExecuteToolFunction>`. To
  expose only readonly functions, we pass
  `createReadonlyWorkspaceFunctionRegistry(...)`. A future mutation
  registry would be a separate factory the caller opts into. This
  keeps approval/least-privilege at the call site, not in the runner.
- **Manifest-driven `stellaCapabilities` tool.** Reuse the existing
  `WorkspaceFunctionManifest` (already a JSON Schema) to render a
  TypeScript `.d.ts`-style snippet (`declare const stella: { ... }`)
  plus a one-paragraph guide. This is what the model reads to learn
  the API surface; no hand-written prompt drift. The tool returns the
  same manifest for both readonly and (future) mutation registries.
- **System prompt points the model at `stella-capabilities`, but
  never inlines the manifest.** The chat system prompt tells the
  model: "before calling `run-code`, call `stella-capabilities` to
  fetch the typed `stella` API." Inlining the rendered `.d.ts` into
  the system prompt would burn tokens on every turn even when the
  model never writes code, and it would silently rot when the
  registry changes. Lazy fetch keeps the prompt small and always
  current.
- **`console.log` is a no-op in the sandbox.** No capture, no
  return, no audit. The system prompt tells the model that only the
  return value of its program comes back as the tool output — if it
  wants to see something, it must `return` it. Reasons: (a) one less
  channel to reason about for prompt injection, (b) no need to
  sanitise control characters or cap log volume, (c) no need to wire
  an audit sink for logs we never expose. Revisit if debugging the
  model's programs becomes painful.
- **Hard execution limits enforced by QuickJS, not by JS.**
  - Memory limit via `runtime.setMemoryLimit`
  - Stack size via `runtime.setMaxStackSize`
  - Wall-clock timeout via `runtime.setInterruptHandler` checking a
    deadline
  - Max number of host calls per execution
  - Max output bytes
  Any breach aborts execution and returns a tagged error to the model.
- **One context per execution, disposed at the end.** No reuse, no
  cached state across calls, no globals leaking between conversations.
  Use the `Scope` helper from `quickjs-emscripten` to guarantee
  cleanup even on throw.
- **TDD: write the runner spec first.** The runner is a pure function
  (`runSandbox({ source, registry, limits })`) and is the only piece
  worth unit testing in isolation. Tests use a fake registry of
  in-memory functions to assert: bridge round-trips, JSON marshalling,
  timeouts, memory limits, host-call cap, validation failures
  surfacing as catchable errors inside the sandbox, no access to
  globals like `fetch`/`process`/`require`.
- **Bridge errors are catchable inside the sandbox.** Validation
  errors and `ChatToolError`s become rejected promises inside the VM
  so model-authored code can `try { ... } catch` and decide what to do
  next. Hard-limit breaches (timeout, memory, host-call cap) abort
  execution non-recoverably.
- **The sandbox is a tool, not the chat tool layer.** The new
  `runCode` tool sits alongside the existing per-function tools in
  `workspace-tools.ts`. We do not remove the direct tools — they
  remain useful for trivial single-step calls. The sandbox is for the
  model to write small programs.
- **Restore the `@stll/anonymize-*` packages.** They were removed from
  `apps/api/package.json` and `apps/web/package.json` to unblock
  installs. Add them back in the same commit that introduces the
  QuickJS dependencies, after verifying the workspace installs.

## Scope

**In scope:**

- Add `quickjs-emscripten` and
  `@jitl/quickjs-ng-wasmfile-release-asyncify` to `apps/api`.
- Restore `@stll/anonymize-data` and `@stll/anonymize-wasm` in
  `apps/api/package.json` and `apps/web/package.json`.
- New `apps/api/src/handlers/chat/tools/execute/sandbox/` module:
  - `run-sandbox.ts` — pure runner: takes `{ source, registry,
    limits }`, returns `{ result | error, hostCalls, durationMs,
    output }`.
  - `transpile.ts` — thin Bun.Transpiler wrapper, TS → JS.
  - `bridge.ts` — host-side dispatch: parse `{ name, argsJson }`, look
    up the registry entry, call `execute`, JSON-encode the result.
  - `limits.ts` — default + max limit constants.
- New `apps/api/src/handlers/chat/tools/execute/manifest-to-typescript.ts`
  — render a `WorkspaceFunctionManifest[]` as a `.d.ts` snippet
  (`declare const stella: { searchContent(input: { ... }):
  Promise<{ ... }> }`).
- New chat tools in `workspace-tools.ts`:
  - `stella-capabilities` — returns the TypeScript declarations + a
    short usage note.
  - `run-code` — accepts a TypeScript source string, runs it in the
    sandbox against the readonly registry, and returns the structured
    result (`{ value, hostCalls, durationMs }`).
- Two additions to the chat system prompt:
  1. Instruct the model to call `stella-capabilities` before its
     first `run-code` call to obtain the typed `stella` API. Do not
     inline the manifest.
  2. Instruct the model that `console.log` is a no-op inside
     `run-code`; the only thing visible to it after execution is the
     value its program `return`s.
- TDD test files (`bun test`):
  - `run-sandbox.test.ts` — bridge round-trip, JSON marshalling, host
    call counting, timeout, memory limit, no `fetch`/`process`,
    multiple awaits, error propagation, output cap.
  - `manifest-to-typescript.test.ts` — snapshot a small manifest to
    its rendered `.d.ts`.
  - `transpile.test.ts` — strips TS types, fails fast on syntax
    errors, rejects ESM imports.
- Wire `run-code` and `stella-capabilities` into `getChatTools` only
  when `workspaceId` is set (same gating as the rest of
  `createWorkspaceTools`).

**Out of scope:**

- Mutation tools inside the sandbox. First slice is readonly only.
  Mutations stay on the direct tool path with `needsApproval`.
- Streaming partial results out of the sandbox. The model gets one
  return value plus captured `console.log` output.
- Caching transpilation across calls.
- A persistent workspace REPL or stateful sandbox sessions.
- Anything beyond `console.log` for sandbox observability.
- Source maps for sandbox errors (nice-to-have, deferred).

## Implementation

- `apps/api/package.json`
  Add `quickjs-emscripten` and the
  `@jitl/quickjs-ng-wasmfile-release-asyncify` variant. Restore
  `@stll/anonymize-data` and `@stll/anonymize-wasm`.

- `apps/web/package.json`
  Restore `@stll/anonymize-data` and `@stll/anonymize-wasm`.

- `apps/api/src/handlers/chat/tools/execute/sandbox/limits.ts`
  Named constants: `MAX_DURATION_MS`, `MAX_MEMORY_BYTES`,
  `MAX_STACK_BYTES`, `MAX_HOST_CALLS`, `MAX_RETURN_BYTES` (cap on the
  serialised return value). No magic numbers in the runner.

- `apps/api/src/handlers/chat/tools/execute/sandbox/transpile.ts`
  `transpileTypeScript(source: string): Result<string, SandboxError>`
  using `new Bun.Transpiler({ loader: "ts", target: "browser" })`. Reject
  ESM `import`/`export` and CommonJS `require` at the source level
  before transpiling, so the sandbox cannot even reference module
  loading.

- `apps/api/src/handlers/chat/tools/execute/sandbox/bridge.ts`
  Host-side dispatcher that takes a registry and a host-call counter,
  exposes a single async function that the runner wires into QuickJS
  via `context.newAsyncifiedFunction`. Validates `name` against the
  registry keys, parses `argsJson`, calls
  `registry[name].execute(args)`, JSON-encodes the result. Throws a
  tagged error on registry miss, JSON parse failure, host-call cap
  breach, or oversized return.

- `apps/api/src/handlers/chat/tools/execute/sandbox/run-sandbox.ts`
  ```ts
  type RunSandboxInput = {
    source: string; // raw TypeScript from the model
    registry: Record<string, ExecuteToolFunction<any, any>>;
    limits?: Partial<SandboxLimits>;
  };
  type RunSandboxResult =
    | { ok: true; value: unknown; hostCalls: number; durationMs: number }
    | { ok: false; error: SandboxError; hostCalls: number;
        durationMs: number };
  ```
  Steps:
  1. Transpile TS → JS.
  2. Build header that injects:
     - `globalThis.console = { log: () => {}, warn: () => {},
       error: () => {}, info: () => {}, debug: () => {} }` — every
       log method is an in-VM no-op so model code that uses them
       doesn't crash, but nothing crosses the boundary.
     - `globalThis.stella = new Proxy({}, { get: (_, name) =>
       (input) => __stellaCall(name, JSON.stringify(input)).then(JSON.parse) })`
  3. Wrap the user source in `(async () => { ... })()` and capture
     the resolved value via a `__return` host function.
  4. Create one `QuickJSAsyncContext` inside a `Scope`, set memory /
     stack / host-call / time limits, register the bridge function,
     evaluate, await the resulting promise, and return.
  5. Reject if the JSON-serialised return value exceeds
     `MAX_RETURN_BYTES`.
  6. Always dispose via the `Scope`, even on error.

- `apps/api/src/handlers/chat/tools/execute/manifest-to-typescript.ts`
  `manifestToTypeScript(manifest: WorkspaceFunctionManifest[]): string`
  Renders a single `declare const stella: { ... }` namespace from the
  JSON Schemas already produced by `toManifestSchema`. Use
  `json-schema-to-typescript` only if it is already present; otherwise
  hand-roll a minimal recursive renderer (the schemas are small and
  fully under our control).

- `apps/api/src/handlers/chat/tools/workspace-tools.ts`
  Add two tools:
  - `stella-capabilities` (no input):
    ```ts
    execute: async () => {
      const registry =
        createReadonlyWorkspaceFunctionRegistry({ ... });
      const manifest =
        createReadonlyWorkspaceFunctionManifest(registry).unwrap();
      return { typescript: manifestToTypeScript(manifest) };
    }
    ```
  - `run-code` (`needsApproval: false`, readonly only): takes a `code`
    string, runs `runSandbox({ source: code, registry })`, and returns
    `{ value, hostCalls, durationMs }` or surfaces a `ChatToolError`
    on failure.

- `apps/api/src/handlers/chat/tools/execute/sandbox/run-sandbox.test.ts`
  TDD spec covering:
  - Identity round-trip (`stella.echo({ x: 1 })` returns `{ x: 1 }`).
  - Multiple sequential awaits within one execution.
  - Host-call counter increments and trips at the cap.
  - Wall-clock timeout aborts an infinite loop.
  - Memory limit aborts an exponential allocation.
  - `fetch`, `process`, `require`, `import` are all `undefined`.
  - Validation errors from a registry function become catchable
    rejected promises in the sandbox.
  - `console.log`, `console.warn`, `console.error`, `console.info`,
    and `console.debug` are callable but produce no observable
    side-effect on the host (no captured output, no error).
  - Returning a non-JSON-serialisable value produces a
    `SandboxError`.
  - Returning a value larger than `MAX_RETURN_BYTES` produces a
    `SandboxError`.

- `apps/api/src/handlers/chat/tools/execute/sandbox/transpile.test.ts`
  - Strips type annotations and interfaces.
  - Rejects `import x from 'y'`.
  - Rejects `require('y')`.
  - Surfaces a syntax error as `SandboxError`.

- `apps/api/src/handlers/chat/tools/execute/manifest-to-typescript.test.ts`
  - Renders a known small manifest into the expected `.d.ts` snippet.
  - Optional types from the input schema become `?:` in the rendered
    declarations.

- `apps/api/src/handlers/chat/tools/chat-tools.ts`
  No structural change; the new tools land in `createWorkspaceTools`
  output and flow through automatically.

- `apps/api/src/handlers/chat/chat-prompt.ts`
  Add two sentences to the workspace-scoped system prompt:
  1. "Before writing code with `run-code`, call `stella-capabilities`
     once to fetch the typed `stella` API declaration." Do not inline
     the manifest itself.
  2. "Inside `run-code`, `console.log` is a no-op. Only the value
     your program `return`s comes back as the tool output, so
     `return` anything you want to inspect."

## Test Cases

- Sandbox executes a multi-step program: list entities, then for each
  entity call `readContent`, then return a summary array. One tool
  call, N host calls, all within limits.
- Programmatic timeout: `while (true) {}` is killed within
  `MAX_DURATION_MS`.
- Programmatic memory blow-up: `let s = "a"; for (let i=0;i<40;i++) s
  += s` is killed by the memory limit.
- Network/IO escape attempts: `fetch`, `XMLHttpRequest`, `process`,
  `require`, `import("...")`, `globalThis.eval` access do not return
  host references; either undefined or no-op.
- Host-call budget: a program that loops `stella.searchContent` 1000
  times is aborted at the cap, with a clear error returned to the
  model.
- Bridge validation: a program that passes `{ workspaceId: 123 }`
  (number instead of string) gets a Valibot error inside its `catch`
  block, not a host crash.
- Capability gating: when called with `workspaceId === null`, the
  `run-code` and `stella-capabilities` tools are not present in
  `getChatTools` output.
- `stella-capabilities` round-trip: the rendered TypeScript declares
  every function in the readonly registry with matching input/output
  shapes from the manifest.
- Concurrent executions: two parallel `runSandbox` calls do not share
  state (each gets its own context, host-call counter, logs).
- Disposal: after a thrown error inside user code, the QuickJS
  context is still disposed (no leak).

## Test Cases (additions for resolved decisions)

- `console.log`, `console.warn`, `console.error`, `console.info`,
  and `console.debug` are no-ops inside the sandbox: calling them
  does not throw, does not appear in the result, and does not reach
  any host-side sink.
- The chat system prompt mentions `stella-capabilities` exactly once
  and does not contain any rendered manifest text.
- The chat system prompt explicitly tells the model that
  `console.log` is a no-op inside `run-code` and that only `return`
  values are observable.

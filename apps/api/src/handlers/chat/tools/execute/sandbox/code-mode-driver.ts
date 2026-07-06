import type {
  ExecutionResult,
  IsolateConfig,
  IsolateContext,
  IsolateDriver,
  ToolBinding,
} from "@tanstack/ai-code-mode";
import { Result } from "better-result";

import type { SandboxLimits } from "@/api/handlers/chat/tools/execute/sandbox/limits";
import { runSandbox } from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox";
import type { SandboxFunctionRegistry } from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox";
import { SANDBOX_READ_GLOBAL } from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox-prelude";

/**
 * A `@tanstack/ai-code-mode` `IsolateDriver` backed by Stella's own hardened
 * QuickJS sandbox (`runSandbox`). This is the seam the split-verdict called for:
 * chat adopts code-mode's generated type stubs, system prompt, and lazy-tool
 * discovery, while every execution still runs through `runSandbox`, so all four
 * Stella hardening layers survive unchanged and by construction:
 *
 * 1. per-execution host-call cap (`maxHostCalls`, default 50),
 * 2. per-execution return-size cap (`maxReturnBytes`, default 64 KiB),
 * 3. global + per-user concurrency admission (keyed on `concurrencyKey`),
 * 4. the `SandboxError` tagged-error taxonomy.
 *
 * The limits are owned here, not by the code-mode config: `IsolateConfig`'s
 * `timeout`/`memoryLimit` are deliberately NOT honored, because code-mode
 * defaults `timeout` to 30_000ms — larger than Stella's 10_000ms deadline — so
 * letting them flow through would silently relax the wall-clock deadline. The
 * driver's own `limits` (falling back to `DEFAULT_SANDBOX_LIMITS` inside
 * `runSandbox` when omitted) stay authoritative for every layer, and
 * `maxHostCalls`/`maxReturnBytes` have no code-mode equivalent at all, so they
 * are always the sandbox defaults.
 */
export type CreateStellaIsolateDriverProps = {
  /**
   * Concurrency-admission key. Chat passes the `userId` so the per-key cap
   * (`MAX_CONCURRENT_SANDBOXES_PER_KEY`) serializes a single user's runs while
   * the global cap (`MAX_CONCURRENT_SANDBOXES`) bounds the process.
   */
  concurrencyKey: string;
  limits?: Partial<SandboxLimits> | undefined;
};

const buildRegistryFromBindings = (
  bindings: Record<string, ToolBinding>,
): SandboxFunctionRegistry => {
  const registry: SandboxFunctionRegistry = {};
  for (const [name, binding] of Object.entries(bindings)) {
    registry[name] = {
      execute: async ({ input }) => await binding.execute(input),
    };
  }
  return registry;
};

/**
 * Alias each `external_<tool>` binding as an in-scope local bound to Stella's
 * `read.<name>` bridge. code-mode's generated code and system prompt call bare
 * `external_*` globals; Stella's prelude only exposes the `read` proxy, so this
 * shim (prepended to the model's code, inside the same async IIFE the transpile
 * step wraps) closes the gap without touching the untouched `runSandbox`
 * prelude. The `read` proxy returns a bridge function for any string key, so
 * destructuring mints one wrapper per binding name.
 */
const buildBindingAliasPrelude = (
  bindings: Record<string, ToolBinding>,
): string => {
  const names = Object.keys(bindings);
  if (names.length === 0) {
    return "";
  }
  return `const { ${names.join(", ")} } = ${SANDBOX_READ_GLOBAL};`;
};

const toExecutionSuccess = <T>(value: unknown): ExecutionResult<T> => ({
  success: true,
  // SAFETY: the sandbox returns a dynamically-typed JSON value; `T` is the
  // caller's unchecked claim about its shape. The assertion is confined to this
  // third-party `execute<T>` boundary and is unavoidable given the interface.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- JSON-value boundary; see note above
  value: value as T,
  logs: [],
});

// eslint-disable-next-line typescript/promise-function-async -- IsolateContext.dispose must return a promise, but a per-call isolate has nothing to tear down; `async` would only trip require-await
const disposeIsolate = (): Promise<void> => Promise.resolve();

export const createStellaIsolateDriver = ({
  concurrencyKey,
  limits,
}: CreateStellaIsolateDriverProps): IsolateDriver => ({
  // eslint-disable-next-line typescript/promise-function-async -- returns a resolved context synchronously (a fresh isolate is created per execute() call, so there is no async setup); `async` would only trip require-await
  createContext: (config: IsolateConfig): Promise<IsolateContext> => {
    const registry = buildRegistryFromBindings(config.bindings);
    const aliasPrelude = buildBindingAliasPrelude(config.bindings);

    const execute = async <T>(code: string): Promise<ExecutionResult<T>> => {
      const source = aliasPrelude === "" ? code : `${aliasPrelude}\n${code}`;
      const result = await runSandbox({
        concurrencyKey,
        source,
        registry,
        ...(limits === undefined ? {} : { limits }),
      });

      if (Result.isOk(result)) {
        return toExecutionSuccess<T>(result.value.value);
      }

      // The SandboxError reason rides in `name`, so the tagged taxonomy
      // (timeout / host-call-limit / memory / return-too-large /
      // non-serialisable-return / forbidden-syntax / transpile / runtime)
      // survives code-mode's coarser `{ message, name }` error shape.
      return {
        success: false,
        error: { name: result.error.reason, message: result.error.message },
      };
    };

    // A fresh isolate is created per `runSandbox` call, so there is nothing to
    // tear down between executions; `dispose` is a no-op the interface requires.
    return Promise.resolve({ execute, dispose: disposeIsolate });
  },
});

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
  value: validateSandboxOutput<T>(value),
  logs: [],
});

// eslint-disable-next-line typescript/no-unnecessary-type-parameters -- T is imposed by the third-party IsolateDriver.execute<T> contract; runtime validation is JSON-shape only
const validateSandboxOutput = <T>(value: unknown): T => {
  if (!isJsonValue<T>(value)) {
    throw new TypeError("Sandbox output must be JSON-compatible");
  }
  return value;
};

// eslint-disable-next-line typescript/no-unnecessary-type-parameters -- carries the IsolateDriver's erased result type after JSON validation
const isJsonValue = <T>(value: unknown): value is T => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== "object") {
    return false;
  }
  // Reject non-plain objects (RegExp, Map, Set, Date, class instances): their
  // own enumerable values are empty, so `every` would vacuously pass and the
  // value would later serialize to `{}` or be lost. Only plain and null-proto
  // objects are JSON-safe.
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
};

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

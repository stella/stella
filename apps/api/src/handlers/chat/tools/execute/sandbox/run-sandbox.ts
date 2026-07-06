import { Result } from "better-result";
import { newAsyncContext } from "quickjs-emscripten";
import type {
  QuickJSAsyncContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
} from "quickjs-emscripten-core";
import { Scope } from "quickjs-emscripten-core";

import { DEFAULT_SANDBOX_LIMITS } from "@/api/handlers/chat/tools/execute/sandbox/limits";
import type { SandboxLimits } from "@/api/handlers/chat/tools/execute/sandbox/limits";
import {
  SANDBOX_HOST_BRIDGE_GLOBAL,
  buildHostBridgePrelude,
} from "@/api/handlers/chat/tools/execute/sandbox/run-sandbox-prelude";
import { transpileSandboxSource } from "@/api/handlers/chat/tools/execute/sandbox/transpile";
import { SandboxError } from "@/api/lib/errors/tagged-errors";

export type SandboxFunction = {
  execute: (props: SandboxFunctionExecuteProps) => Promise<unknown>;
};

export type SandboxFunctionRegistry = Record<string, SandboxFunction>;

export type SandboxFunctionExecuteProps = {
  input: unknown;
  signal: AbortSignal;
};

type DumpedError = { name?: string; message?: string };
type VmBridgeError = { name: string; message: string };
type HostBridgeState = {
  abortController: AbortController;
  closed: boolean;
  hostCalls: number;
  hostCallLimitTripped: boolean;
  pendingHostWork: Set<Promise<void>>;
};

const UTF_8_ENCODER = new TextEncoder();

const isDumpedError = (value: unknown): value is DumpedError =>
  typeof value === "object" && value !== null;

const dumpVmError = (
  ctx: QuickJSAsyncContext,
  handle: QuickJSHandle,
): DumpedError | undefined =>
  Result.try((): unknown => ctx.dump(handle)).match({
    ok: (dumped) => {
      if (typeof dumped === "string") {
        return { message: dumped };
      }
      if (isDumpedError(dumped)) {
        return dumped;
      }
      if (dumped === undefined) {
        return undefined;
      }

      const message = Result.try(() => JSON.stringify(dumped)).unwrapOr(
        "Unknown sandbox error",
      );
      return { message };
    },
    err: () => undefined,
  });

export type RunSandboxInput = {
  concurrencyKey: string;
  source: string;
  registry: SandboxFunctionRegistry;
  limits?: Partial<SandboxLimits>;
};

export type RunSandboxSuccess = {
  value: unknown;
  hostCalls: number;
  durationMs: number;
};

export type RunSandboxResult = Result<RunSandboxSuccess, SandboxError>;

const MAX_CONCURRENT_SANDBOXES = 4;
const MAX_CONCURRENT_SANDBOXES_PER_KEY = 1;

type SandboxAdmissionRelease = () => void;
type SandboxAdmissionWaiter = {
  concurrencyKey: string;
  resolve: (release: SandboxAdmissionRelease) => void;
};

let activeSandboxCount = 0;
const activeSandboxCountByKey = new Map<string, number>();
const sandboxAdmissionQueue: SandboxAdmissionWaiter[] = [];

// Every in-flight host-call promise (see `runHostCall`), tracked at module
// scope purely so tests can await the full unwind of a run. A timed-out run
// returns at its deadline while its orphaned host promise keeps settling in
// the background; without a way to await that tail, the leftover work bleeds
// across test and file boundaries (Bun runs a package's test files in one
// shared process) and perturbs the timing-sensitive admission-queue tests.
// Entries are added on registration and removed when the promise settles, so
// this never retains work and does not alter execution behaviour.
const sandboxHostWorkInFlight = new Set<Promise<void>>();

/**
 * Default budget for {@link awaitSandboxAdmissionIdle}. Generously above the
 * longest legitimate orphaned host-work tail (bounded by a run's wall-clock
 * deadline, {@link DEFAULT_SANDBOX_LIMITS}.maxDurationMs) yet below the sandbox
 * test suite's 15s per-test ceiling, so a genuinely stranded host promise fails
 * the drain fast with a diagnostic instead of silently 15s-timing-out every
 * subsequent test.
 */
export const SANDBOX_ADMISSION_IDLE_TIMEOUT_MS = 10_000;

type SandboxAdmissionSnapshot = {
  activeSandboxCount: number;
  queuedWaiters: number;
  hostWorkInFlight: number;
};

const snapshotSandboxAdmission = (): SandboxAdmissionSnapshot => ({
  activeSandboxCount,
  queuedWaiters: sandboxAdmissionQueue.length,
  hostWorkInFlight: sandboxHostWorkInFlight.size,
});

/**
 * Thrown by {@link awaitSandboxAdmissionIdle} (a test-only hook) when the
 * process-global admission state cannot reach idle within its budget. It exists
 * to make a poisoned state loud and localized: a single host promise that never
 * settles (e.g. a test that abandons an unresolved gate before releasing it)
 * otherwise strands an entry in the module-global in-flight set forever, and the
 * drain — which every sandbox `afterEach` awaits — would then hang for the full
 * per-test timeout on that test AND every test after it in the shared Bun
 * process. Surfacing the live counters names the culprit instead of burying it
 * under a uniform wall of 15s hook timeouts.
 */
export class SandboxAdmissionNotIdleError extends Error {
  readonly snapshot: SandboxAdmissionSnapshot;

  constructor(snapshot: SandboxAdmissionSnapshot, timeoutMs: number) {
    super(
      `Sandbox admission did not reach idle within ${timeoutMs}ms: ` +
        `activeSandboxCount=${snapshot.activeSandboxCount}, ` +
        `queuedWaiters=${snapshot.queuedWaiters}, ` +
        `hostWorkInFlight=${snapshot.hostWorkInFlight}. ` +
        "A host promise was likely stranded (e.g. a test abandoned an unresolved gate); " +
        "resolve/settle every host call it starts, or lower the run's maxDurationMs.",
    );
    this.name = "SandboxAdmissionNotIdleError";
    this.snapshot = snapshot;
  }
}

type AwaitSandboxAdmissionIdleOptions = {
  /** Drain budget; see {@link SANDBOX_ADMISSION_IDLE_TIMEOUT_MS}. */
  timeoutMs?: number;
};

// Await the current in-flight host work, but give up at `deadline` so a
// never-settling promise cannot hang the drain. The budget timer is always
// cleared so it can never fire into the following test.
const raceHostWorkAgainstDeadline = async (
  hostWork: readonly Promise<void>[],
  deadline: number,
): Promise<void> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, Math.max(0, deadline - Date.now()));
  });
  try {
    await Promise.race([Promise.allSettled(hostWork), budget]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
};

/**
 * Test-only drain hook: resolves once the process-global sandbox admission
 * state is fully idle — no admitted runs, an empty admission queue, and no
 * orphaned host work still settling in the background. It only READS the
 * admission counters (`activeSandboxCount`, the queue) and awaits
 * already-scheduled work; it never resets those counters, so it cannot mask a
 * real admission-accounting bug. Every sandbox test file registers it in
 * `afterEach` (see `registerSandboxTestHygiene`) so one test's background host
 * work cannot leak into the timing of the next.
 *
 * The wait is bounded: a host promise that never settles cannot hold an
 * admission slot (the slot is released in `runSandbox`'s `finally` at the run's
 * deadline), but it lingers forever in `sandboxHostWorkInFlight`. Without a
 * bound the drain would then hang for the whole per-test timeout on this test
 * and every later one. On timeout we therefore evict the stranded in-flight
 * host work (a test-support set, safe to clear once we have waited past every
 * legitimate tail) so the poison does not cascade, and throw a diagnostic naming
 * the live counters. Admission counts are never cleared: if they are the stuck
 * dimension, that is a genuine accounting bug and it should keep surfacing.
 */
export const awaitSandboxAdmissionIdle = async ({
  timeoutMs = SANDBOX_ADMISSION_IDLE_TIMEOUT_MS,
}: AwaitSandboxAdmissionIdleOptions = {}): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (
    // oxlint-disable-next-line no-unmodified-loop-condition -- released by admission callbacks that settle during the awaited work below, not in this loop body
    activeSandboxCount > 0 ||
    sandboxAdmissionQueue.length > 0 ||
    sandboxHostWorkInFlight.size > 0
  ) {
    if (Date.now() >= deadline) {
      const snapshot = snapshotSandboxAdmission();
      // Drop the stranded host-work tail so the next test starts clean; keep
      // the admission counters intact so a real accounting bug still surfaces.
      sandboxHostWorkInFlight.clear();
      throw new SandboxAdmissionNotIdleError(snapshot, timeoutMs);
    }

    if (sandboxHostWorkInFlight.size > 0) {
      // oxlint-disable-next-line no-await-in-loop -- drain loop: race the current in-flight snapshot against the remaining budget, then re-check for work registered while we waited
      await raceHostWorkAgainstDeadline(
        Array.from(sandboxHostWorkInFlight),
        deadline,
      );
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- yield a macrotask so a just-released slot's queue flush can settle before re-checking
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

const buildSandboxScript = (transpiledBody: string): string =>
  `${buildHostBridgePrelude()}\n${transpiledBody}`;

const hasDeadlinePassed = (deadline: number): boolean => Date.now() >= deadline;

const errorMessageFromUnknown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const getUtf8ByteLength = (value: string): number =>
  UTF_8_ENCODER.encode(value).byteLength;

const okUndefined = <TError = never>(): Result<undefined, TError> =>
  Result.ok<null, TError>(null).map(() => globalThis.undefined);

const createTimeoutError = (limits: SandboxLimits): SandboxError =>
  new SandboxError({
    reason: "timeout",
    message: `Sandbox execution exceeded ${limits.maxDurationMs}ms.`,
  });

const createHostCallLimitError = (limits: SandboxLimits): SandboxError =>
  new SandboxError({
    reason: "host-call-limit",
    message: `Host call limit (${limits.maxHostCalls}) exceeded.`,
  });

const createMemoryError = (message: string): SandboxError =>
  new SandboxError({
    reason: "memory",
    message: `Sandbox exceeded memory limit: ${message}`,
  });

const createRuntimeError = (message: string, cause?: unknown): SandboxError =>
  new SandboxError({
    reason: "runtime",
    message,
    cause,
  });

const createVmBridgeError = (name: string, message: string): VmBridgeError => ({
  name,
  message,
});

const rejectVmPromise = (
  ctx: QuickJSAsyncContext,
  deferred: QuickJSDeferredPromise,
  error: VmBridgeError,
): void => {
  using err = ctx.newError(error);
  deferred.reject(err);
};

type ShouldIgnoreHostCompletionProps = {
  ctx: QuickJSAsyncContext;
  deadline: number;
  state: HostBridgeState;
};

const shouldIgnoreHostCompletion = ({
  ctx,
  deadline,
  state,
}: ShouldIgnoreHostCompletionProps): boolean =>
  state.closed || hasDeadlinePassed(deadline) || !ctx.alive;

type SettleDeferredWithBridgeErrorProps = {
  ctx: QuickJSAsyncContext;
  deferred: QuickJSDeferredPromise;
  deadline: number;
  error: VmBridgeError;
  state: HostBridgeState;
};

const settleDeferredWithBridgeError = ({
  ctx,
  deferred,
  deadline,
  error,
  state,
}: SettleDeferredWithBridgeErrorProps): void => {
  if (shouldIgnoreHostCompletion({ ctx, deadline, state })) {
    return;
  }

  rejectVmPromise(ctx, deferred, error);
};

type SerializeJsonValueResult = Result<string, SandboxError>;

const serializeJsonValue = (
  value: unknown,
  message: string,
): SerializeJsonValueResult =>
  Result.try({
    try: (): string | undefined => JSON.stringify(value),
    catch: (cause) =>
      new SandboxError({
        reason: "non-serialisable-return",
        message,
        cause,
      }),
  }).andThen((serialised) =>
    serialised === undefined
      ? Result.err(
          new SandboxError({
            reason: "non-serialisable-return",
            message,
          }),
        )
      : Result.ok(serialised),
  );

type SerializeHostFunctionValueResult = Result<
  string | undefined,
  SandboxError
>;

const serializeHostFunctionValue = (
  value: unknown,
): SerializeHostFunctionValueResult =>
  value === undefined
    ? okUndefined()
    : serializeJsonValue(
        value,
        "Host function return value is not JSON-serialisable.",
      );

const createHostBridgeState = (): HostBridgeState => ({
  abortController: new AbortController(),
  closed: false,
  hostCalls: 0,
  hostCallLimitTripped: false,
  pendingHostWork: new Set(),
});

const getActiveSandboxCountForKey = (concurrencyKey: string): number =>
  activeSandboxCountByKey.get(concurrencyKey) ?? 0;

const canAdmitSandbox = (concurrencyKey: string): boolean =>
  activeSandboxCount < MAX_CONCURRENT_SANDBOXES &&
  getActiveSandboxCountForKey(concurrencyKey) <
    MAX_CONCURRENT_SANDBOXES_PER_KEY;

const incrementSandboxAdmissionCounts = (concurrencyKey: string): void => {
  activeSandboxCount += 1;
  activeSandboxCountByKey.set(
    concurrencyKey,
    getActiveSandboxCountForKey(concurrencyKey) + 1,
  );
};

const decrementSandboxAdmissionCounts = (concurrencyKey: string): void => {
  activeSandboxCount -= 1;
  const nextCount = getActiveSandboxCountForKey(concurrencyKey) - 1;
  if (nextCount <= 0) {
    activeSandboxCountByKey.delete(concurrencyKey);
    return;
  }

  activeSandboxCountByKey.set(concurrencyKey, nextCount);
};

const createSandboxAdmissionRelease = (
  concurrencyKey: string,
): SandboxAdmissionRelease => {
  let released = false;

  return () => {
    if (released) {
      return;
    }

    released = true;
    decrementSandboxAdmissionCounts(concurrencyKey);
    flushSandboxAdmissionQueue();
  };
};

const flushSandboxAdmissionQueue = (): void => {
  if (sandboxAdmissionQueue.length === 0) {
    return;
  }

  let queueIndex = 0;
  while (queueIndex < sandboxAdmissionQueue.length) {
    if (activeSandboxCount >= MAX_CONCURRENT_SANDBOXES) {
      return;
    }

    const waiter = sandboxAdmissionQueue[queueIndex];
    if (!waiter || !canAdmitSandbox(waiter.concurrencyKey)) {
      queueIndex += 1;
      continue;
    }

    sandboxAdmissionQueue.splice(queueIndex, 1);
    incrementSandboxAdmissionCounts(waiter.concurrencyKey);
    waiter.resolve(createSandboxAdmissionRelease(waiter.concurrencyKey));
  }
};

type AcquireSandboxAdmissionResult = Promise<SandboxAdmissionRelease>;
const acquireSandboxAdmission = async (
  concurrencyKey: string,
): AcquireSandboxAdmissionResult =>
  await new Promise((resolve) => {
    sandboxAdmissionQueue.push({
      concurrencyKey,
      resolve,
    });
    flushSandboxAdmissionQueue();
  });

export const runSandbox = async ({
  concurrencyKey,
  source,
  registry,
  limits: partialLimits,
}: RunSandboxInput): Promise<RunSandboxResult> => {
  const releaseSandboxAdmission = await acquireSandboxAdmission(concurrencyKey);

  try {
    const startedAt = Date.now();
    const limits: SandboxLimits = {
      ...DEFAULT_SANDBOX_LIMITS,
      ...partialLimits,
    };
    const deadline = startedAt + limits.maxDurationMs;

    return await Result.gen(async function* () {
      const transpiled = yield* transpileSandboxSource(source);
      const execution = yield* Result.await(
        executeSandboxScript({
          script: buildSandboxScript(transpiled),
          registry,
          limits,
          deadline,
        }),
      );

      return Result.ok({
        value: execution.value,
        hostCalls: execution.hostCalls,
        durationMs: Date.now() - startedAt,
      });
    });
  } finally {
    releaseSandboxAdmission();
  }
};

type MarshalReturnValueResult = Result<unknown, SandboxError>;

const marshalReturnValue = (
  ctx: QuickJSAsyncContext,
  valueHandle: QuickJSHandle,
  limits: SandboxLimits,
): MarshalReturnValueResult =>
  Result.gen(function* () {
    const value = yield* Result.try({
      try: (): unknown => ctx.dump(valueHandle),
      catch: (cause) =>
        new SandboxError({
          reason: "non-serialisable-return",
          message: "Sandbox return value could not be marshalled.",
          cause,
        }),
    });

    if (value === undefined) {
      return okUndefined();
    }

    const serialised = yield* serializeJsonValue(
      value,
      "Sandbox return value is not JSON-serialisable.",
    );
    const byteLength = getUtf8ByteLength(serialised);

    if (byteLength > limits.maxReturnBytes) {
      return Result.err(
        new SandboxError({
          reason: "return-too-large",
          message: `Sandbox return value (${byteLength} bytes) exceeds limit of ${limits.maxReturnBytes} bytes.`,
        }),
      );
    }

    return Result.ok(value);
  });

type ExecuteSandboxSuccess = {
  value: unknown;
  hostCalls: number;
};

type ExecuteSandboxScriptResult = Result<ExecuteSandboxSuccess, SandboxError>;
type ExecuteSandboxScriptProps = {
  script: string;
  registry: SandboxFunctionRegistry;
  limits: SandboxLimits;
  deadline: number;
};

type CreateSandboxContextResult = Result<QuickJSAsyncContext, SandboxError>;

const createSandboxContext = async (): Promise<CreateSandboxContextResult> =>
  await Result.tryPromise({
    try: async () => await newAsyncContext(),
    catch: (cause) =>
      new SandboxError({
        reason: "runtime",
        message: "Failed to initialize sandbox runtime.",
        cause,
      }),
  });

const executeSandboxScript = async ({
  script,
  registry,
  limits,
  deadline,
}: ExecuteSandboxScriptProps): Promise<ExecuteSandboxScriptResult> => {
  const state = createHostBridgeState();

  return await Scope.withScopeAsync(async (scope) => {
    const sandboxContext = await createSandboxContext();
    if (Result.isError(sandboxContext)) {
      return Result.err(sandboxContext.error);
    }

    const ctx = scope.manage(sandboxContext.value);
    configureSandboxRuntime({ ctx, limits, deadline, state });

    const readCall = ctx.newFunction(
      SANDBOX_HOST_BRIDGE_GLOBAL,
      (nameHandle, argsHandle) =>
        handleStellaCall({
          ctx,
          scope,
          state,
          registry,
          limits,
          deadline,
          nameHandle,
          argsHandle,
        }),
    );
    scope.manage(readCall);
    ctx.setProp(ctx.global, SANDBOX_HOST_BRIDGE_GLOBAL, readCall);

    try {
      return (
        await runScriptInContext({
          ctx,
          scope,
          state,
          script,
          limits,
          deadline,
        })
      ).map((value) => ({
        value,
        hostCalls: state.hostCalls,
      }));
    } finally {
      state.abortController.abort();
      state.closed = true;
    }
  });
};

type ConfigureSandboxRuntimeProps = {
  ctx: QuickJSAsyncContext;
  limits: SandboxLimits;
  deadline: number;
  state: HostBridgeState;
};

const configureSandboxRuntime = ({
  ctx,
  limits,
  deadline,
  state,
}: ConfigureSandboxRuntimeProps): void => {
  ctx.runtime.setMemoryLimit(limits.maxMemoryBytes);
  ctx.runtime.setMaxStackSize(limits.maxStackBytes);
  ctx.runtime.setInterruptHandler(
    () => state.hostCallLimitTripped || hasDeadlinePassed(deadline),
  );
};

type HandleStellaCallProps = {
  ctx: QuickJSAsyncContext;
  scope: Scope;
  state: HostBridgeState;
  registry: SandboxFunctionRegistry;
  limits: SandboxLimits;
  deadline: number;
  nameHandle: QuickJSHandle;
  argsHandle: QuickJSHandle;
};

const handleStellaCall = ({
  ctx,
  scope,
  state,
  registry,
  limits,
  deadline,
  nameHandle,
  argsHandle,
}: HandleStellaCallProps): QuickJSHandle => {
  const deferred = scope.manage(ctx.newPromise());

  if (state.hostCalls >= limits.maxHostCalls) {
    state.hostCallLimitTripped = true;
    rejectVmPromise(
      ctx,
      deferred,
      createVmBridgeError(
        "SandboxHostCallLimit",
        createHostCallLimitError(limits).message,
      ),
    );
    return deferred.handle;
  }

  state.hostCalls += 1;

  const preparedCall = prepareStellaCall({
    ctx,
    registry,
    nameHandle,
    argsHandle,
  });
  if (Result.isError(preparedCall)) {
    rejectVmPromise(ctx, deferred, preparedCall.error);
    return deferred.handle;
  }

  const work = runHostCall({
    ctx,
    deferred,
    state,
    deadline,
    fn: preparedCall.value.fn,
    parsedArgs: preparedCall.value.parsedArgs,
  });
  state.pendingHostWork.add(work);

  return deferred.handle;
};

type PrepareStellaCallSuccess = {
  fn: SandboxFunction;
  name: string;
  parsedArgs: unknown;
};

type PrepareStellaCallResult = Result<PrepareStellaCallSuccess, VmBridgeError>;
type PrepareStellaCallProps = {
  ctx: QuickJSAsyncContext;
  registry: SandboxFunctionRegistry;
  nameHandle: QuickJSHandle;
  argsHandle: QuickJSHandle;
};

const prepareStellaCall = ({
  ctx,
  registry,
  nameHandle,
  argsHandle,
}: PrepareStellaCallProps): PrepareStellaCallResult =>
  Result.gen(function* () {
    const name = ctx.getString(nameHandle);
    const fn = yield* getSandboxFunction({ registry, name });
    const parsedArgs = yield* parseSandboxArgs({
      name,
      argsJson: ctx.getString(argsHandle),
    });

    return Result.ok({
      fn,
      name,
      parsedArgs,
    });
  });

type GetSandboxFunctionProps = {
  registry: SandboxFunctionRegistry;
  name: string;
};

const getSandboxFunction = ({
  registry,
  name,
}: GetSandboxFunctionProps): Result<SandboxFunction, VmBridgeError> => {
  if (!Object.hasOwn(registry, name)) {
    return Result.err(
      createVmBridgeError(
        "SandboxUnknownFunction",
        `Unknown read function: ${name}`,
      ),
    );
  }

  const fn = registry[name];
  if (!fn) {
    return Result.err(
      createVmBridgeError(
        "SandboxUnknownFunction",
        `Unknown read function: ${name}`,
      ),
    );
  }

  return Result.ok(fn);
};

type ParseSandboxArgsResult = Result<unknown, VmBridgeError>;
type ParseSandboxArgsProps = {
  name: string;
  argsJson: string;
};

const parseSandboxArgs = ({
  name,
  argsJson,
}: ParseSandboxArgsProps): ParseSandboxArgsResult =>
  Result.try({
    try: (): unknown => JSON.parse(argsJson),
    catch: (cause) =>
      createVmBridgeError(
        "SandboxInvalidArgs",
        `Failed to parse args for ${name}: ${errorMessageFromUnknown(cause)}`,
      ),
  });

type RunHostCallProps = {
  ctx: QuickJSAsyncContext;
  deferred: QuickJSDeferredPromise;
  state: HostBridgeState;
  deadline: number;
  fn: SandboxFunction;
  parsedArgs: unknown;
};

// oxlint-disable-next-line typescript/promise-function-async -- must synchronously build and return the workPromise reference registered in pendingHostWork
const runHostCall = ({
  ctx,
  deferred,
  state,
  deadline,
  fn,
  parsedArgs,
}: RunHostCallProps): Promise<void> => {
  const workPromise = (async () => {
    const hostResult = await Result.tryPromise({
      try: async () =>
        await fn.execute({
          input: parsedArgs,
          signal: state.abortController.signal,
        }),
      catch: (cause) =>
        createVmBridgeError("SandboxHostError", errorMessageFromUnknown(cause)),
    });

    if (Result.isError(hostResult)) {
      settleDeferredWithBridgeError({
        ctx,
        deferred,
        deadline,
        error: hostResult.error,
        state,
      });
      return;
    }

    const serialised = serializeHostFunctionValue(hostResult.value);
    if (Result.isError(serialised)) {
      settleDeferredWithBridgeError({
        ctx,
        deferred,
        deadline,
        error: createVmBridgeError(
          "SandboxHostError",
          serialised.error.message,
        ),
        state,
      });
      return;
    }

    if (shouldIgnoreHostCompletion({ ctx, deadline, state })) {
      return;
    }

    if (serialised.value === undefined) {
      deferred.resolve(ctx.undefined);
      return;
    }

    using result = ctx.newString(serialised.value);
    deferred.resolve(result);
  })()
    .catch((error: unknown) => {
      settleDeferredWithBridgeError({
        ctx,
        deferred,
        deadline,
        error: createVmBridgeError(
          "SandboxHostError",
          errorMessageFromUnknown(error),
        ),
        state,
      });
    })
    .finally(() => {
      state.pendingHostWork.delete(workPromise);
      sandboxHostWorkInFlight.delete(workPromise);
    });

  sandboxHostWorkInFlight.add(workPromise);
  return workPromise;
};

type RunScriptInContextResult = Result<unknown, SandboxError>;
type RunScriptInContextProps = {
  ctx: QuickJSAsyncContext;
  scope: Scope;
  state: HostBridgeState;
  script: string;
  limits: SandboxLimits;
  deadline: number;
};

const runScriptInContext = async ({
  ctx,
  scope,
  state,
  script,
  limits,
  deadline,
}: RunScriptInContextProps): Promise<RunScriptInContextResult> => {
  const evalResult = ctx.evalCode(script, "sandbox.js");
  if (evalResult.error) {
    const errHandle = scope.manage(evalResult.error);
    const dumpedError = dumpVmError(ctx, errHandle);
    return Result.err(
      classifyVmError(
        dumpedError,
        limits,
        deadline,
        state.hostCallLimitTripped,
      ),
    );
  }

  const promiseHandle = scope.manage(evalResult.value);
  const settled = await driveVmUntilSettled({
    ctx,
    scope,
    state,
    promiseHandle,
    limits,
    deadline,
  });
  if (Result.isError(settled)) {
    return settled;
  }

  if (settled.value.kind === "error") {
    const errHandle = scope.manage(settled.value.handle);
    return Result.err(
      classifyVmError(
        dumpVmError(ctx, errHandle),
        limits,
        deadline,
        state.hostCallLimitTripped,
      ),
    );
  }

  const valueHandle = scope.manage(settled.value.handle);
  return marshalReturnValue(ctx, valueHandle, limits);
};

type PromiseSettlement =
  | { kind: "value"; handle: QuickJSHandle }
  | { kind: "error"; handle: QuickJSHandle };

type DriveVmUntilSettledResult = Result<PromiseSettlement, SandboxError>;
type DriveVmUntilSettledProps = {
  ctx: QuickJSAsyncContext;
  scope: Scope;
  state: HostBridgeState;
  promiseHandle: QuickJSHandle;
  limits: SandboxLimits;
  deadline: number;
};

const driveVmUntilSettled = async ({
  ctx,
  scope,
  state,
  promiseHandle,
  limits,
  deadline,
}: DriveVmUntilSettledProps): Promise<DriveVmUntilSettledResult> => {
  while (true) {
    const drained = ctx.runtime.executePendingJobs();
    if (drained.error) {
      const errHandle = scope.manage(drained.error);
      const dumpedError = dumpVmError(ctx, errHandle);
      return Result.err(
        classifyVmError(
          dumpedError,
          limits,
          deadline,
          state.hostCallLimitTripped,
        ),
      );
    }

    const promiseState = ctx.getPromiseState(promiseHandle);
    if (promiseState.type === "fulfilled") {
      return Result.ok({
        kind: "value",
        handle: scope.manage(promiseState.value),
      });
    }
    if (promiseState.type === "rejected") {
      return Result.ok({
        kind: "error",
        handle: scope.manage(promiseState.error),
      });
    }

    if (hasDeadlinePassed(deadline)) {
      return Result.err(
        classifyVmError(
          undefined,
          limits,
          deadline,
          state.hostCallLimitTripped,
        ),
      );
    }

    if (state.pendingHostWork.size > 0) {
      // oxlint-disable-next-line no-await-in-loop -- VM event loop: must wait for host progress before pumping the next VM step
      const waitResult = await waitForHostProgress({
        pendingHostWork: state.pendingHostWork,
        deadline,
      });
      if (waitResult === "timeout") {
        return Result.err(
          classifyVmError(
            undefined,
            limits,
            deadline,
            state.hostCallLimitTripped,
          ),
        );
      }
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- VM event loop: yields the microtask queue before pumping the next VM step
    await Promise.resolve();
  }
};

type HostProgress = "progress" | "timeout";
type WaitForHostProgressProps = {
  pendingHostWork: Set<Promise<void>>;
  deadline: number;
};

const waitForHostProgress = async ({
  pendingHostWork,
  deadline,
}: WaitForHostProgressProps): Promise<HostProgress> => {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return "timeout";
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => {
      resolve("timeout");
    }, remainingMs);
  });
  const progressPromise = Promise.race(Array.from(pendingHostWork)).then(
    () => "progress" as const,
  );

  const result = await Promise.race([progressPromise, timeoutPromise]);
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
  }

  return result;
};

const classifyVmError = (
  err: { name?: string; message?: string } | undefined,
  limits: SandboxLimits,
  deadline: number,
  hostCallLimitTripped: boolean,
): SandboxError => {
  const message = err?.message ?? "Unknown sandbox error";
  if (hostCallLimitTripped) {
    return createHostCallLimitError(limits);
  }
  if (hasDeadlinePassed(deadline)) {
    return createTimeoutError(limits);
  }
  if (/out of memory|memory/iu.test(message)) {
    return createMemoryError(message);
  }

  return createRuntimeError(message);
};

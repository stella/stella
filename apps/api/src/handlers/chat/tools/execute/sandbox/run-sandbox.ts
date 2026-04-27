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
    // oxlint-disable-next-line unicorn/no-useless-undefined
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
    try: () => JSON.stringify(value),
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
  while (
    queueIndex < sandboxAdmissionQueue.length &&
    activeSandboxCount < MAX_CONCURRENT_SANDBOXES
  ) {
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

    const stellaCall = ctx.newFunction(
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
    scope.manage(stellaCall);
    ctx.setProp(ctx.global, SANDBOX_HOST_BRIDGE_GLOBAL, stellaCall);

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
        `Unknown stella function: ${name}`,
      ),
    );
  }

  const fn = registry[name];
  if (!fn) {
    return Result.err(
      createVmBridgeError(
        "SandboxUnknownFunction",
        `Unknown stella function: ${name}`,
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

// oxlint-disable-next-line typescript/promise-function-async
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
    });

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
  if (/out of memory|memory/i.test(message)) {
    return createMemoryError(message);
  }

  return createRuntimeError(message);
};

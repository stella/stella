import { Result } from "better-result";
import * as v from "valibot";

/**
 * The only protocol client of the stella browser. It can send the methods
 * listed in `CDP_COMMANDS` and nothing else: each has its parameters' type
 * and a schema for the part of its answer the holder reads. What is not
 * here is never sent, so no network, cookie, storage, debugger or
 * main-world script method can reach the browser: no `Runtime.enable` or
 * `Runtime.evaluate`, and `Runtime.callFunctionOn` only ever runs in the
 * isolated world the holder created (`read-path.ts`).
 */

const EMPTY = v.object({});

const frameSchema = v.object({
  id: v.string(),
  parentId: v.optional(v.string()),
  loaderId: v.string(),
  url: v.string(),
});

type FrameTreeNode = {
  frame: v.InferOutput<typeof frameSchema>;
  childFrames?: FrameTreeNode[] | undefined;
};

const frameTreeSchema: v.GenericSchema<FrameTreeNode> = v.object({
  frame: frameSchema,
  childFrames: v.optional(v.array(v.lazy(() => frameTreeSchema))),
});

const targetInfoSchema = v.object({
  targetId: v.string(),
  type: v.string(),
  url: v.string(),
  openerId: v.optional(v.string()),
});

/** Each method the client may send, with the part of its answer it reads. */
const CDP_COMMANDS = {
  "Browser.getVersion": v.object({
    product: v.string(),
    protocolVersion: v.string(),
  }),
  "Browser.close": EMPTY,
  "Browser.setDownloadBehavior": EMPTY,
  "Target.setDiscoverTargets": EMPTY,
  "Target.createTarget": v.object({ targetId: v.string() }),
  "Target.attachToTarget": v.object({ sessionId: v.string() }),
  "Target.closeTarget": EMPTY,
  "Target.setAutoAttach": EMPTY,
  "Page.enable": EMPTY,
  "Page.navigate": v.object({
    frameId: v.string(),
    loaderId: v.optional(v.string()),
    errorText: v.optional(v.string()),
  }),
  "Page.getFrameTree": v.object({ frameTree: frameTreeSchema }),
  "Page.createIsolatedWorld": v.object({ executionContextId: v.number() }),
  "Runtime.callFunctionOn": v.object({
    result: v.object({ type: v.string(), value: v.optional(v.unknown()) }),
    exceptionDetails: v.optional(v.unknown()),
  }),
} as const;

export type CdpMethod = keyof typeof CDP_COMMANDS;

/** The methods the client can send: the allowlist a test holds a scenario to. */
export const CDP_METHOD_ALLOWLIST: readonly CdpMethod[] = Object.freeze(
  Object.keys(CDP_COMMANDS).filter((method): method is CdpMethod =>
    Object.hasOwn(CDP_COMMANDS, method),
  ),
);

const ALLOWED: ReadonlySet<string> = new Set(CDP_METHOD_ALLOWLIST);

/** The parameters each method is sent with. */
type CdpParams = {
  "Browser.getVersion": Record<string, never>;
  "Browser.close": Record<string, never>;
  "Browser.setDownloadBehavior": { behavior: "deny" };
  "Target.setDiscoverTargets": { discover: boolean };
  "Target.createTarget": {
    url: string;
    newWindow: boolean;
    background: boolean;
  };
  "Target.attachToTarget": { targetId: string; flatten: true };
  "Target.closeTarget": { targetId: string };
  "Target.setAutoAttach": {
    autoAttach: boolean;
    waitForDebuggerOnStart: boolean;
    flatten: true;
  };
  "Page.enable": Record<string, never>;
  "Page.navigate": { url: string };
  "Page.getFrameTree": Record<string, never>;
  "Page.createIsolatedWorld": {
    frameId: string;
    worldName: string;
    /** The protocol's spelling. */
    grantUniveralAccess: false;
  };
  "Runtime.callFunctionOn": {
    functionDeclaration: string;
    executionContextId: number;
    arguments: [{ value: unknown }];
    returnByValue: true;
    awaitPromise: true;
  };
};

type CdpResult<M extends CdpMethod> = v.InferOutput<(typeof CDP_COMMANDS)[M]>;

/** The events the holder listens to, with the part of each it reads. */
const CDP_EVENTS = {
  "Target.targetCreated": v.object({ targetInfo: targetInfoSchema }),
  "Target.targetDestroyed": v.object({ targetId: v.string() }),
  "Target.targetCrashed": v.object({ targetId: v.string() }),
  "Target.attachedToTarget": v.object({
    sessionId: v.string(),
    targetInfo: targetInfoSchema,
  }),
  "Target.detachedFromTarget": v.object({ sessionId: v.string() }),
  "Target.targetInfoChanged": v.object({ targetInfo: targetInfoSchema }),
  "Page.loadEventFired": v.object({}),
} as const;

export type CdpEvent = keyof typeof CDP_EVENTS;

type CdpEventParams<E extends CdpEvent> = v.InferOutput<(typeof CDP_EVENTS)[E]>;

export type CdpFrameTree = FrameTreeNode;

export type CdpFailure =
  /** The browser answered with a protocol error. */
  | { type: "protocol"; message: string }
  /** The answer did not have the shape the holder reads. */
  | { type: "invalid" }
  | { type: "timeout" }
  /** The pipe ended before the answer came. */
  | { type: "disconnected" }
  | { type: "aborted" }
  /** Not an allowlisted method; nothing was sent. */
  | { type: "refused" };

const incomingSchema = v.object({
  id: v.optional(v.number()),
  method: v.optional(v.string()),
  params: v.optional(v.unknown()),
  result: v.optional(v.unknown()),
  error: v.optional(v.object({ message: v.string() })),
  sessionId: v.optional(v.string()),
});

type Pending = {
  settle: (outcome: Result<unknown, CdpFailure>) => void;
};

/** How the client reaches the pipe. */
type CdpTransport = {
  send: (json: string) => boolean;
};

const DEFAULT_TIMEOUT_MS = 30_000;

type SendOptions = {
  sessionId?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
};

type Listener = (params: unknown, sessionId: string | null) => void;

export const createCdpClient = (
  transport: CdpTransport,
  {
    onSend,
  }: {
    /** Each method as it is sent; the test hooks record them. */
    onSend?: (method: CdpMethod) => void;
  } = {},
) => {
  let nextId = 0;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<Listener>>();
  let connected = true;

  const send = async <M extends CdpMethod>(
    method: M,
    params: CdpParams[M],
    { sessionId, signal, timeoutMs = DEFAULT_TIMEOUT_MS }: SendOptions = {},
  ): Promise<Result<CdpResult<M>, CdpFailure>> => {
    // The types already hold callers to the list; this holds a cast to it.
    if (!ALLOWED.has(method)) {
      return Result.err({ type: "refused" });
    }
    if (!connected) {
      return Result.err({ type: "disconnected" });
    }
    if (signal?.aborted === true) {
      return Result.err({ type: "aborted" });
    }
    nextId += 1;
    const id = nextId;
    const { promise, resolve } =
      Promise.withResolvers<Result<unknown, CdpFailure>>();
    const settle = (outcome: Result<unknown, CdpFailure>) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      pending.delete(id);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      settle(Result.err({ type: "timeout" }));
    }, timeoutMs);
    const onAbort = () => {
      settle(Result.err({ type: "aborted" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, { settle });
    onSend?.(method);
    const written = transport.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    );
    if (!written) {
      settle(Result.err({ type: "disconnected" }));
    }
    const outcome = await promise;
    if (Result.isError(outcome)) {
      return outcome;
    }
    const parsed = v.safeParse(CDP_COMMANDS[method], outcome.value);
    return parsed.success
      ? Result.ok(parsed.output)
      : Result.err({ type: "invalid" });
  };

  /** Feeds one message from the pipe to its call or its listeners. */
  const receive = (json: string) => {
    const decoded = Result.try((): unknown => JSON.parse(json));
    if (Result.isError(decoded)) {
      return;
    }
    const message = v.safeParse(incomingSchema, decoded.value);
    if (!message.success) {
      return;
    }
    const { error, id, method, params, result, sessionId } = message.output;
    if (id !== undefined) {
      const call = pending.get(id);
      if (call === undefined) {
        return;
      }
      call.settle(
        error === undefined
          ? Result.ok(result ?? {})
          : Result.err({ message: error.message, type: "protocol" }),
      );
      return;
    }
    if (method === undefined) {
      return;
    }
    for (const listener of listeners.get(method) ?? []) {
      listener(params, sessionId ?? null);
    }
  };

  const on = <E extends CdpEvent>(
    event: E,
    listener: (params: CdpEventParams<E>, sessionId: string | null) => void,
  ): (() => void) => {
    const wrapped: Listener = (params, sessionId) => {
      const parsed = v.safeParse(CDP_EVENTS[event], params);
      if (parsed.success) {
        listener(parsed.output, sessionId);
      }
    };
    const set = listeners.get(event) ?? new Set<Listener>();
    set.add(wrapped);
    listeners.set(event, set);
    return () => {
      set.delete(wrapped);
    };
  };

  /** The pipe ended: every call still waiting fails, and no more are sent. */
  const disconnect = () => {
    connected = false;
    for (const call of [...pending.values()]) {
      call.settle(Result.err({ type: "disconnected" }));
    }
    listeners.clear();
  };

  return { send, receive, on, disconnect };
};

export type CdpClient = ReturnType<typeof createCdpClient>;

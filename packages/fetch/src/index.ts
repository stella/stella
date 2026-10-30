// parser-output-unchanged: transport timeout fields on the fetcher type do not change parsed output.
export { isConnectionFailure } from "./connection-failure";

export type FetchTimeout =
  | { type: "total"; ms: number }
  | { type: "headers"; ms: number }
  | { type: "idle"; ms: number };

export type TransportRequestInit = RequestInit & {
  timeout?: FetchTimeout;
  timeoutMs?: number;
};

export type Fetcher = (
  input: string | URL | Request,
  init?: TransportRequestInit,
) => Promise<Response>;

export type FetchWithTimeoutInit = Omit<RequestInit, "signal"> & {
  signal?: AbortSignal | undefined;
} & (
    | { timeout: FetchTimeout; timeoutMs?: number }
    // Existing numeric callers are enumerated by the transfer-window guard.
    | {
        /** Use an explicit timeout policy for new callers. */
        timeoutMs: number;
        timeout?: never;
      }
  );

const executeFetchWithTimeout = async (
  fetcher: Fetcher | undefined,
  input: string | URL | Request,
  { timeout, timeoutMs, signal, ...init }: FetchWithTimeoutInit,
): Promise<Response> => {
  const callerSignals = [
    signal,
    input instanceof Request ? input.signal : undefined,
  ].filter((candidate): candidate is AbortSignal => candidate !== undefined);
  const activeFetcher = fetcher ?? globalThis.fetch;
  const duration = timeout?.ms ?? timeoutMs;

  if (
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration < 0 ||
    duration > 2_147_483_647
  ) {
    throw new DOMException(
      "Invalid fetch timeout duration",
      "NotSupportedError",
    );
  }

  if (timeout === undefined) {
    // A numeric deadline covers the whole exchange through the transport's
    // own signal, and the caller gets the transport's response unchanged.
    return await activeFetcher(input, {
      ...init,
      signal: AbortSignal.any([
        ...callerSignals,
        AbortSignal.timeout(duration),
      ]),
      timeoutMs: duration,
    });
  }
  const policy = timeout;

  const controller = new AbortController();
  const combined = AbortSignal.any([...callerSignals, controller.signal]);
  const expire = () =>
    controller.abort(new DOMException("Fetch timed out", "TimeoutError"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const reset = () => {
    clear();
    timer = setTimeout(expire, duration);
  };
  reset();
  const response = await Promise.resolve()
    .then(
      async () =>
        await activeFetcher(input, {
          ...init,
          signal: combined,
          timeout: policy,
          timeoutMs: duration,
        }),
    )
    .catch((error: unknown) => {
      clear();
      throw error;
    })
    .finally(() => {
      if (policy.type !== "total") {
        clear();
      }
    });
  if (controller.signal.aborted) {
    // The abort reason is the failure. Cancelling only releases the body, and
    // a body the abort already errored rejects with that same stored reason.
    await Promise.allSettled([response.body?.cancel(combined.reason)]);
    throw combined.reason;
  }
  if (combined.aborted) {
    if (policy.type === "total") {
      // Total deadlines historically delegated this settlement race to the
      // transport. Keep a response that wins a caller abort so resumable
      // consumers can use work completed before they observe the signal.
      clear();
      return response;
    }
    await Promise.allSettled([response.body?.cancel(combined.reason)]);
    throw combined.reason;
  }
  if (policy.type === "headers" || response.body === null) {
    clear();
    return response;
  }

  const reader = response.body.getReader();
  let stopped = false;
  let cancellation: Promise<void> | undefined;
  let abort: () => void;
  const finish = () => {
    stopped = true;
    clear();
    combined.removeEventListener("abort", abort);
  };
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      abort = () => {
        if (stopped) {
          return;
        }
        finish();
        stream.error(combined.reason);
        // The fetch signal aborts the transport; cancellation drains the reader
        // even when an injected fetcher does not implement signal handling.
        cancellation = reader.cancel(combined.reason).then(
          () => reader.releaseLock(),
          () => reader.releaseLock(),
        );
      };
      combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) {
        abort();
        return;
      }
    },
    async pull(stream) {
      if (stopped) {
        await cancellation;
        return;
      }
      if (policy.type === "idle") {
        reset();
      }
      await reader
        .read()
        .finally(() => {
          if (policy.type === "idle") {
            clear();
          }
        })
        .then(
          ({ done, value }) => {
            if (stopped) {
              return undefined;
            }
            if (done) {
              finish();
              reader.releaseLock();
              stream.close();
              return undefined;
            }
            stream.enqueue(value);
            return undefined;
          },
          (error: unknown) => {
            if (stopped) {
              return;
            }
            finish();
            reader.releaseLock();
            stream.error(error);
          },
        );
      await cancellation;
    },
    async cancel(reason: unknown) {
      if (stopped) {
        await cancellation;
        return;
      }
      finish();
      await reader.cancel(reason).finally(() => reader.releaseLock());
    },
  });
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // Response's constructor does not carry transport metadata across a stream.
  Object.defineProperties(wrapped, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return wrapped;
};

/** Creates a wrapper with the supplied transport and an explicit timeout policy. */
export const createFetchWithTimeout =
  (fetcher: Fetcher) =>
  async (
    input: string | URL | Request,
    init: FetchWithTimeoutInit,
  ): Promise<Response> =>
    await executeFetchWithTimeout(fetcher, input, init);

/** Uses the current global fetch implementation at request time. */
export const fetchWithTimeout = async (
  input: string | URL | Request,
  init: FetchWithTimeoutInit,
): Promise<Response> => await executeFetchWithTimeout(undefined, input, init);

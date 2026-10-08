// parser-output-unchanged: transport timeout policies do not change parsed output.
export { isConnectionFailure } from "./connection-failure";

export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type FetchTimeout =
  | { type: "headers"; ms: number }
  | { type: "idle"; ms: number };

export type FetchWithTimeoutInit = Omit<RequestInit, "signal"> & {
  signal?: AbortSignal | undefined;
} & (
    | { timeout: FetchTimeout; timeoutMs?: never }
    // Existing numeric callers are enumerated by the transfer-window guard.
    | {
        /** Choose a headers or idle timeout for new callers. */
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
  if (timeout === undefined) {
    const total = AbortSignal.timeout(timeoutMs);
    return await activeFetcher(input, {
      ...init,
      signal: AbortSignal.any([...callerSignals, total]),
    });
  }

  if (
    !Number.isFinite(timeout.ms) ||
    timeout.ms < 0 ||
    timeout.ms > 2_147_483_647
  ) {
    throw new DOMException(
      "Invalid fetch timeout duration",
      "NotSupportedError",
    );
  }

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
    timer = setTimeout(expire, timeout.ms);
  };
  reset();
  const response = await Promise.resolve()
    .then(async () => await activeFetcher(input, { ...init, signal: combined }))
    .finally(clear);
  if (combined.aborted) {
    // The abort reason is the failure. Cancelling only releases the body, and
    // a body the abort already errored rejects with that same stored reason.
    await Promise.allSettled([response.body?.cancel(combined.reason)]);
    throw combined.reason;
  }
  if (timeout.type === "headers" || response.body === null) {
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
      reset();
      await reader
        .read()
        .finally(clear)
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

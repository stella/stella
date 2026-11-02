// parser-output-unchanged: transport timeout fields on the fetcher type do not change parsed output.
export { isConnectionFailure } from "./connection-failure";
export type FetchTimeout =
  { type: "total"; ms: number } | { type: "headers"; ms: number };

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

  if (timeout === undefined || timeout.type === "total") {
    // A total deadline covers the whole exchange through the transport's own
    // signal, and the caller gets the transport's response unchanged: a body
    // re-wrapped in a script stream is invisible to the browser's network
    // inspection and costs a stream hop on every response.
    return await activeFetcher(input, {
      ...init,
      signal: AbortSignal.any([
        ...callerSignals,
        AbortSignal.timeout(duration),
      ]),
      ...(timeout === undefined ? {} : { timeout }),
      timeoutMs: duration,
    });
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
  timer = setTimeout(expire, duration);
  const response = await Promise.resolve()
    .then(
      async () =>
        await activeFetcher(input, {
          ...init,
          signal: combined,
          timeout,
          timeoutMs: duration,
        }),
    )
    .finally(clear);
  if (combined.aborted) {
    // The abort reason is the failure. Cancelling only releases the body, and
    // a body the abort already errored rejects with that same stored reason.
    await Promise.allSettled([response.body?.cancel(combined.reason)]);
    throw combined.reason;
  }
  return response;
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

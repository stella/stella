/**
 * `fetch()` wrapper that always bounds a request with a stall timeout.
 *
 * A `fetch()` call whose only abort source is a caller's signal (e.g. a
 * request's own `AbortSignal`, dropped on client disconnect) never aborts
 * on its own: a stalled upstream response hangs the request indefinitely.
 * `timeoutMs` is required so every call site states its own budget
 * explicitly; pass a caller `signal` to additionally abort when the caller
 * does (client disconnect, upstream cancellation, etc.). Any signal already
 * carried by an `input` `Request` is composed in too, so it is never
 * silently replaced.
 *
 * The `require-fetch-timeout` oxlint rule forbids raw `fetch()` calls under
 * `apps/api/src` for this reason; route them through here instead.
 */
export type FetchWithTimeoutInit = Omit<BunFetchRequestInit, "signal"> & {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
};

export const fetchWithTimeout = async (
  input: string | URL | Request,
  { timeoutMs, signal, ...init }: FetchWithTimeoutInit,
): Promise<Response> => {
  const signals = [
    signal,
    input instanceof Request ? input.signal : undefined,
  ].filter((candidate): candidate is AbortSignal => candidate !== undefined);
  signals.push(AbortSignal.timeout(timeoutMs));

  return await fetch(input, {
    ...init,
    signal: AbortSignal.any(signals),
  });
};

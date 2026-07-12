/**
 * `fetch()` wrapper that always bounds a request with a stall timeout.
 *
 * A `fetch()` call whose only abort source is a caller's signal (e.g. a
 * TanStack Query `{ signal }`, dropped on unmount or refetch) never aborts
 * on its own: a stalled upstream response hangs the request indefinitely
 * as long as the component stays mounted. `timeoutMs` is required so every
 * call site states its own budget explicitly; pass a caller `signal` to
 * additionally abort when the caller does (unmount, user cancel, etc.). Any
 * signal already carried by an `input` `Request` is composed in too, so it
 * is never silently replaced.
 *
 * The `require-fetch-timeout` oxlint rule forbids raw `fetch()` calls under
 * `apps/web/src` for this reason; route them through here instead.
 */
export type FetchWithTimeoutInit = Omit<RequestInit, "signal"> & {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
};

export const fetchWithTimeout = async (
  input: RequestInfo | URL,
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

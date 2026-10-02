import { Result } from "better-result";

import { FetchBoundaryError } from "@stll/errors";

import { isConnectionFailure } from "./connection-failure";

export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type FetchWithTimeoutInit = Omit<RequestInit, "signal"> & {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
};

const executeFetchWithTimeout = async (
  fetcher: Fetcher | undefined,
  input: string | URL | Request,
  { timeoutMs, signal, ...init }: FetchWithTimeoutInit,
): Promise<Response> => {
  const callerSignals = [
    signal,
    input instanceof Request ? input.signal : undefined,
  ].filter((candidate): candidate is AbortSignal => candidate !== undefined);
  const timeout = AbortSignal.timeout(timeoutMs);
  const activeFetcher = fetcher ?? globalThis.fetch;

  const response = await Result.tryPromise({
    try: async () =>
      await activeFetcher(input, {
        ...init,
        // Avoid the AbortSignal.any allocation when the timeout is the only signal.
        signal:
          callerSignals.length === 0
            ? timeout
            : AbortSignal.any([...callerSignals, timeout]),
      }),
    catch: (cause) => cause,
  });
  if (Result.isOk(response)) {
    return response.value;
  }
  // Caller cancellation and request timeouts keep their original identity:
  // retry policies distinguish them from a failed connection.
  if (
    callerSignals.some((candidate) => candidate.aborted) ||
    timeout.aborted ||
    !isConnectionFailure(response.error)
  ) {
    throw response.error;
  }
  throw new FetchBoundaryError({
    message: "Fetch connection failed",
    url: input instanceof Request ? input.url : String(input),
    failureKind: "source_unreachable",
    cause: response.error,
  });
};

/**
 * Creates a fetch wrapper that requires a timeout and composes it with caller
 * and Request signals. Supplying the fetcher keeps the policy independent of
 * the runtime's fetch implementation.
 */
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

/** Messages a native `fetch` rejects with when the request gets no HTTP
 *  response (offline, DNS failure, connection reset). They vary by engine:
 *  - Chromium: "Failed to fetch"
 *  - Firefox:  "NetworkError when attempting to fetch resource."
 *  - Safari:   "Load failed"
 *  Matched exactly: a failed module load also starts with "Failed to fetch",
 *  and it names a stale deployment, not a dropped connection. */
const NATIVE_FETCH_FAILURE_MESSAGES: ReadonlySet<string> = new Set([
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
  "Load failed",
]);

export const isNativeFetchFailure = (error: unknown): error is TypeError =>
  error instanceof TypeError &&
  NATIVE_FETCH_FAILURE_MESSAGES.has(error.message);

/**
 * Per-request memoization keyed by the raw `Request` object.
 *
 * More than one stage of a request can ask for the same resolution: the
 * request's authorization (`resolveRequestAuth` in `lib/auth.ts`) is read
 * by gates that run before validation as well as by the member
 * authenticator. Wrapping an expensive resolve with {@link memoizePerRequest}
 * guarantees the underlying work runs exactly once per request no matter
 * how many stages ask for it.
 *
 * Callers own the `WeakMap` (rather than this module holding a global
 * one) so each memoized computation gets its own cache and cannot
 * collide with another. Keying on the `Request` instance means there is
 * zero cross-request caching: a new request always gets a fresh
 * computation, and cache entries are freed once the request is no longer
 * referenced (no explicit cleanup, no leak). This is a correctness
 * requirement, not just a memory optimization, for anything
 * security-sensitive (e.g. session/permission resolution) memoized this
 * way — a revoked session must still be re-checked on the very next
 * request.
 *
 * The in-flight `Promise` is cached, not just the settled value, so
 * concurrent resolve invocations for the same request (which can happen
 * within a single synchronous hook chain before the first await settles)
 * still only trigger one computation.
 */
export const memoizePerRequest = async <TResult>(
  cache: WeakMap<Request, Promise<TResult>>,
  request: Request,
  compute: () => Promise<TResult>,
): Promise<TResult> => {
  const cached = cache.get(request);
  if (cached) {
    return await cached;
  }

  const pending = compute();
  cache.set(request, pending);
  return await pending;
};

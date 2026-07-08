/**
 * Per-request memoization keyed by the raw `Request` object.
 *
 * Elysia can invoke the same macro's `resolve` hook more than once per
 * request when the macro property is declared at multiple independent
 * call sites (`.guard()`, `.group()`, a per-route config) — each site
 * expands into its own hook function, and every one of them runs (see
 * `validateAuth` in `lib/auth.ts` for the concrete case that motivated
 * this). Wrapping an expensive resolve with {@link memoizePerRequest}
 * guarantees the underlying work runs exactly once per request no matter
 * how many times the macro fires.
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

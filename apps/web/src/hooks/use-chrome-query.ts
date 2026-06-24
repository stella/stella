import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import type {
  DefaultError,
  QueryKey,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";

import { useMountEffect } from "@/hooks/use-effect";

/**
 * Returns `false` on the first render and flips to `true` after mount. The
 * single mounted-gate primitive shared by `useChromeQuery` and by chrome hooks
 * that aren't `useQuery` (e.g. `useInfiniteQuery`, `useQueries`), which compose
 * `enabled: useHasMounted() && ...` manually.
 */
export const useHasMounted = (): boolean => {
  const [m, setM] = useState(false);
  useMountEffect(() => {
    setM(true);
  });
  return m;
};

/**
 * `useQuery` for persistent chrome (the layout shell, sidebar, inspector) that
 * mounts on every route.
 *
 * A cold-cache fetch started during the first render resolves and notifies the
 * still-mounting fiber, which React reports in dev as "Can't perform a React
 * state update on a component that hasn't mounted yet". That warning is the
 * source of a recurring family of cold-start flakes (route-smoke treats it as a
 * failure), and it migrates between routes because the offending query lives in
 * shared chrome, not in any one page.
 *
 * This wrapper returns cached data synchronously (a warm cache renders with no
 * flash) but defers the *network fetch* until after mount, so the fetch can
 * only ever resolve on a mounted component. The warning then becomes
 * structurally impossible rather than something each route has to pre-seed.
 *
 * Chrome must use this instead of bare `useQuery` (enforced by the
 * `no-bare-chrome-query` lint rule). Route/page content keeps using `useQuery`
 * with loader-backed cache guarantees.
 *
 * `enabled` is composed: a `false` from the caller still disables the query. In
 * TanStack Query v5 `enabled` is boolean-only (the function form was removed),
 * so the caller's boolean is simply ANDed with the mount gate.
 *
 * Hydration-safe under TanStack Start SSR: `useMountEffect` never runs on the
 * server, so `mounted` is `false` on both the server render and the first
 * client render. Those two renders see identical query state, so there is no
 * hydration mismatch. Where a loader dehydrates query data the cache is already
 * warm and renders server-side normally; only the post-hydration *fetch* is
 * deferred past mount.
 */
export const useChromeQuery = <
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): UseQueryResult<TData, TError> => {
  const mounted = useHasMounted();

  return useQuery({
    ...options,
    enabled: options.enabled !== false && mounted,
  });
};

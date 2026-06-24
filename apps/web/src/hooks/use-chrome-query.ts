import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import type {
  QueryKey,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";

import { useMountEffect } from "@/hooks/use-effect";

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
 * `enabled` is composed: a `false` from the caller still disables the query;
 * the boolean form is the only one chrome uses, so the function form is treated
 * as enabled and simply gated on mount.
 */
export const useChromeQuery = <
  TQueryFnData,
  TError,
  TData,
  TQueryKey extends QueryKey,
>(
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): UseQueryResult<TData, TError> => {
  const [mounted, setMounted] = useState(false);
  useMountEffect(() => {
    setMounted(true);
  });

  return useQuery({
    ...options,
    enabled: options.enabled !== false && mounted,
  });
};

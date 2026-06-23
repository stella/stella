// Passive regression fixture for
// `no-raw-route-query-client/no-raw-route-query-client`.
//
// Each `oxlint-disable-next-line` suppresses a route-loader query pattern the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI.

import * as ReactQuery from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import {
  ensureCriticalQueryData,
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
  fetchRouteQuery,
  prefetchNonCriticalQuery,
  prefetchRouteQuery,
} from "@/lib/react-query";

declare const options: {
  queryKey: readonly ["fixture"];
  queryFn: () => Promise<string>;
};
declare const infiniteOptions: {
  queryKey: readonly ["fixture", "infinite"];
  queryFn: () => Promise<string>;
  initialPageParam: null;
  getNextPageParam: () => null;
};

function PendingComponent() {
  // oxlint-disable-next-line no-raw-route-query-client/no-raw-route-query-client
  useQuery(options);

  // oxlint-disable-next-line no-raw-route-query-client/no-raw-route-query-client
  ReactQuery.useSuspenseQuery(options);

  const queryClient = useQueryClient();
  queryClient.getQueryData(options.queryKey);

  return null;
}

export const Route = createFileRoute("/__fixture")({
  pendingComponent: PendingComponent,
  loader: async ({ context: { queryClient } }) => {
    // oxlint-disable-next-line no-raw-route-query-client/no-raw-route-query-client
    await ensureCriticalQueryData(queryClient, options);

    // oxlint-disable-next-line no-raw-route-query-client/no-raw-route-query-client
    await prefetchNonCriticalQuery(queryClient, options, () => undefined);

    // oxlint-disable-next-line no-raw-route-query-client/no-raw-route-query-client
    await queryClient.ensureQueryData(options);

    // oxlint-disable-next-line no-raw-route-query-client/no-raw-route-query-client
    await queryClient.ensureInfiniteQueryData(infiniteOptions);

    // oxlint-disable-next-line no-raw-route-query-client/no-raw-route-query-client
    await queryClient.fetchQuery(options);

    await ensureRouteQueryData(queryClient, options);
    await ensureRouteInfiniteQueryData(queryClient, infiniteOptions);
    await fetchRouteQuery(queryClient, options);
    await prefetchRouteQuery(queryClient, options, () => undefined);
  },
});

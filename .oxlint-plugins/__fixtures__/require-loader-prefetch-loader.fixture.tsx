// Passive regression fixture for
// `require-loader-prefetch/require-loader-prefetch`.
//
// Route file WITH a loader. A factory referenced inside the loader body passes;
// a factory the loader never touches must flag. Covers both the factory-call
// and bare-identifier argument shapes on the passing side.

import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { ensureRouteQueryData, prefetchRouteQuery } from "@/lib/react-query";

declare const viewsOptions: (id: string) => {
  queryKey: readonly ["views", string];
  queryFn: () => Promise<string>;
};
declare const overviewOptions: {
  queryKey: readonly ["overview"];
  queryFn: () => Promise<string>;
};
declare const activityOptions: (id: string) => {
  queryKey: readonly ["activity", string];
  queryFn: () => Promise<string>;
};

export const Route = createFileRoute("/__fixture/with-loader")({
  component: WithLoaderComponent,
  loader: async ({ context: { queryClient } }) => {
    // Prefetched (blocking) — viewsOptions is referenced here.
    await ensureRouteQueryData(queryClient, viewsOptions("id"));
    // Prefetched (non-blocking) — overviewOptions is referenced here.
    void prefetchRouteQuery(queryClient, overviewOptions, () => undefined);
  },
});

function WithLoaderComponent() {
  // Factory referenced in loader — NOT flagged.
  const views = useSuspenseQuery(viewsOptions("id"));

  // Bare-identifier factory referenced in loader — NOT flagged.
  const overview = useSuspenseQuery(overviewOptions);

  // activityOptions is never prefetched in the loader — MUST flag.
  // oxlint-disable-next-line require-loader-prefetch/require-loader-prefetch
  const activity = useSuspenseQuery(activityOptions("id"));

  return `${views.data}${overview.data}${activity.data}`;
}

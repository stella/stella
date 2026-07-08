// Passive regression fixture for
// `require-loader-prefetch/require-loader-prefetch`.
//
// Same colocated-import shape as `require-loader-prefetch-child-missing`, but
// the route `loader` prefetches `childEntityOptions` (the factory the child
// component's `useSuspenseQuery` call depends on) via `ensureRouteQueryData`.
// The cross-file check must NOT flag this: the factory is referenced in the
// loader, exactly like the in-file case in `require-loader-prefetch-loader`.

import { createFileRoute } from "@tanstack/react-router";

import { ensureRouteQueryData } from "@/lib/react-query";
import { ChildComponent } from "@/routes/-components/require-loader-prefetch-child.fixture";

declare const childEntityOptions: (id: string) => {
  queryKey: readonly ["child-entity", string];
  queryFn: () => Promise<string>;
};

export const Route = createFileRoute("/__fixture/child-ok-loader")({
  component: ChildOkLoaderComponent,
  loader: async ({ context: { queryClient } }) => {
    await ensureRouteQueryData(queryClient, childEntityOptions("id"));
  },
});

function ChildOkLoaderComponent() {
  return <ChildComponent />;
}

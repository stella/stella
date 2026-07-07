// Passive regression fixture for
// `require-loader-prefetch/require-loader-prefetch`.
//
// A non-route file (no `createFileRoute`). `useSuspenseQuery` here is the
// caller's responsibility to back with a Suspense boundary; the loader-prefetch
// invariant does not apply, so nothing must flag.

import { useSuspenseQuery } from "@tanstack/react-query";

declare const detailOptions: (id: string) => {
  queryKey: readonly ["detail", string];
  queryFn: () => Promise<string>;
};

export function NonRouteComponent() {
  // No createFileRoute in this file — NOT flagged.
  const detail = useSuspenseQuery(detailOptions("id"));
  return detail.data;
}

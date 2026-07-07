// Passive regression fixture for
// `require-loader-prefetch/require-loader-prefetch`.
//
// A route file with no `useSuspenseQuery` call at all. There is no waterfall to
// guard against, so a missing loader must NOT flag.

import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

declare const statusOptions: {
  queryKey: readonly ["status"];
  queryFn: () => Promise<string>;
};

export const Route = createFileRoute("/__fixture/no-suspense")({
  component: NoSuspenseComponent,
});

function NoSuspenseComponent() {
  // Non-suspense query, no loader — NOT flagged.
  const status = useQuery(statusOptions);
  return status.data ?? "";
}

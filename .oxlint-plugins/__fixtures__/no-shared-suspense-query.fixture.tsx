// Passive regression fixture for
// `no-shared-suspense-query/no-shared-suspense-query`.

import { useSuspenseQuery } from "@tanstack/react-query";
import * as ReactQuery from "@tanstack/react-query";

declare const options: { queryKey: readonly unknown[]; queryFn: () => string };

export function SharedChromeFixture() {
  // Named import — MUST flag.
  // oxlint-disable-next-line no-shared-suspense-query/no-shared-suspense-query
  const first = useSuspenseQuery(options);

  // Namespace import — MUST flag.
  // oxlint-disable-next-line no-shared-suspense-query/no-shared-suspense-query
  const second = ReactQuery.useSuspenseQuery(options);

  const third = ReactQuery.useQuery(options);

  return `${first.data}${second.data}${third.data ?? ""}`;
}

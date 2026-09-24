// Passive regression fixture for
// `no-bare-chrome-query/no-bare-chrome-query`.

import { useQuery } from "@tanstack/react-query";
import * as ReactQuery from "@tanstack/react-query";

declare const options: { queryKey: readonly unknown[]; queryFn: () => string };
declare const useChromeQuery: typeof useQuery;

export function ChromeFixture() {
  // Named import — MUST flag.
  // oxlint-disable-next-line no-bare-chrome-query/no-bare-chrome-query
  const first = useQuery(options);

  // Namespace import — MUST flag.
  // oxlint-disable-next-line no-bare-chrome-query/no-bare-chrome-query
  const second = ReactQuery.useQuery(options);

  // Deferred chrome query hook.
  // expect-clean: no-bare-chrome-query/no-bare-chrome-query
  const third = useChromeQuery(options);

  // Other namespace member.
  // expect-clean: no-bare-chrome-query/no-bare-chrome-query
  const client = ReactQuery.useQueryClient();

  return `${first.data ?? ""}${second.data ?? ""}${third.data ?? ""}${String(client.isFetching())}`;
}

import { queryOptions } from "@tanstack/react-query";

import { Temporal } from "@stll/time";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";

const ACCOUNT_DATA_EXPORT_POLL_INTERVAL_MS = 2000;
const ACCOUNT_DATA_EXPORT_READY_REFRESH_MAX_INTERVAL_MS = 60_000;

const accountDataExportKeys = {
  latest: (userId: string) => ["me", "data-exports", userId] as const,
};

export const accountDataExportLatestOptions = (userId: string) =>
  queryOptions({
    queryKey: accountDataExportKeys.latest(userId),
    queryFn: async ({ signal }) =>
      unwrapEden(await api.me["data-exports"].get({ fetch: { signal } }))
        .latest,
    refetchInterval: (query) => {
      const status = query.state.data;
      if (status?.status === "requested" || status?.status === "processing") {
        return ACCOUNT_DATA_EXPORT_POLL_INTERVAL_MS;
      }
      if (status?.status === "ready") {
        const expiresAt = Temporal.Instant.from(
          status.expiresAt,
        ).epochMilliseconds;
        return Math.min(
          ACCOUNT_DATA_EXPORT_READY_REFRESH_MAX_INTERVAL_MS,
          Math.max(1000, expiresAt - Temporal.Now.instant().epochMilliseconds),
        );
      }
      return false;
    },
  });

export type AccountDataExportStatus = NonNullable<
  Awaited<
    ReturnType<
      NonNullable<ReturnType<typeof accountDataExportLatestOptions>["queryFn"]>
    >
  >
>;

import { queryOptions } from "@tanstack/react-query";

import { Temporal } from "@stll/time";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";

const AUDIT_EXPORT_POLL_INTERVAL_MS = 2000;
// A ready archive the owner has not taken yet: its download is recorded by
// the browser's own request, so the panel follows it shortly after.
const AUDIT_EXPORT_DOWNLOAD_POLL_INTERVAL_MS = 3000;
const AUDIT_EXPORT_READY_REFRESH_MAX_INTERVAL_MS = 60_000;

export const organizationAuditExportKeys = {
  latest: (organizationId: string, userId: string) =>
    ["organizations", organizationId, "audit-export", userId] as const,
};

/** The signed-in owner's latest audit log archive of the organization. */
export const organizationAuditExportLatestOptions = (
  organizationId: string,
  userId: string,
) =>
  queryOptions({
    queryKey: organizationAuditExportKeys.latest(organizationId, userId),
    queryFn: async ({ signal }) =>
      unwrapApiResponse(
        await api.organizations["audit-export"].get({ fetch: { signal } }),
      ).latest,
    refetchInterval: (query) => {
      const status = query.state.data;
      if (status?.status === "requested" || status?.status === "processing") {
        return AUDIT_EXPORT_POLL_INTERVAL_MS;
      }
      if (status?.status === "ready" && !status.downloaded) {
        return AUDIT_EXPORT_DOWNLOAD_POLL_INTERVAL_MS;
      }
      if (status?.status === "ready") {
        const expiresAt = Temporal.Instant.from(
          status.expiresAt,
        ).epochMilliseconds;
        return Math.min(
          AUDIT_EXPORT_READY_REFRESH_MAX_INTERVAL_MS,
          Math.max(1000, expiresAt - Temporal.Now.instant().epochMilliseconds),
        );
      }
      return false;
    },
  });

export type OrganizationAuditExportStatus = NonNullable<
  Awaited<
    ReturnType<
      NonNullable<
        ReturnType<typeof organizationAuditExportLatestOptions>["queryFn"]
      >
    >
  >
>;

import { createFileRoute } from "@tanstack/react-router";

import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";
import { routeLoadMode } from "@/lib/query-view.logic";
import { prefetchRouteQuery } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";

import {
  AUDIT_LOG_PAGE_LIMIT,
  DEFAULT_PERFORMER_FILTER,
} from "./-organization.audit-logs.logic";
import { AuditLogsPage } from "./-organization.audit-logs.page";
import { AuditLogsPending } from "./-organization.audit-logs.pending";
import { auditLogOptions } from "./organization/-queries/audit-logs";

export const Route = createFileRoute(
  "/_protected/settings/organization/audit-logs",
)({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.organization.auditLogs",
      to: "/settings/organization/audit-logs",
    }),
  },
  loader: async ({ cause, context }) => {
    const options = auditLogOptions({
      viewer: {
        userId: context.user.id,
        organizationId: context.user.activeOrganizationId,
      },
      key: {
        limit: AUDIT_LOG_PAGE_LIMIT,
        performer: DEFAULT_PERFORMER_FILTER,
      },
    });
    const fetchPage = prefetchRouteQuery(
      context.queryClient,
      options,
      (error: unknown) => {
        getAnalytics().captureError(error, {
          fingerprintKey: "admin.audit-logs.loader:failure",
          scope: {
            type: "request",
            method: "GET",
            routeTemplate: "/_protected/settings/organization/audit-logs",
          },
        });
      },
    );

    if (
      routeLoadMode({
        cause,
        hasCachedPages:
          context.queryClient.getQueryData(options.queryKey) !== undefined,
      }) === "await"
    ) {
      await fetchPage;
    } else {
      detached(fetchPage, "organization-settings.audit-logs-prefetch");
    }
  },
  head: () => ({
    meta: [{ title: pageTitle("settings.organization.auditLogs") }],
  }),
  component: AuditLogsPage,
  pendingComponent: AuditLogsPending,
});

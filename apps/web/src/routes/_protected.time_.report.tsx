import { createFileRoute, redirect } from "@tanstack/react-router";

import { todayIn } from "@/components/billing/work-week.logic";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";

import { timeReportOptions } from "./_protected.time_.report/-components/report-query";
import { reportSearchSchema } from "./_protected.time_.report/-components/report-search";
import { resolveReportSearch } from "./_protected.time_.report/-components/report.logic";
import { TimeReportPage } from "./_protected.time_.report/-components/report.page";
import { TimeReportPending } from "./_protected.time_.report/-components/report.pending";

export const Route = createFileRoute("/_protected/time_/report")({
  validateSearch: reportSearchSchema,
  staticData: {
    presentation: routePresentation(
      {
        type: "label",
        labelKey: "billing.timeReport.title",
        to: "/time/report",
      },
      { type: "label", labelKey: "billing.timesheets", to: "/time" },
    ),
  },
  loaderDeps: ({ search }) => search,
  beforeLoad: async ({ context }) => {
    if (
      !(await isTimeBillingRouteEnabled(context.queryClient, {
        userId: context.user.id,
        organizationId: context.user.activeOrganizationId,
      }))
    ) {
      redirect({ to: "/workspaces", throw: true });
    }
    const role = await ensureRouteQueryData(context.queryClient, roleOptions);
    if (
      !authClient.organization.checkRolePermission({
        role,
        permissions: { timeEntry: ["read"] },
      })
    ) {
      redirect({ to: "/workspaces", throw: true });
    }
  },
  loader: async ({ context, deps }) => {
    await ensureRouteQueryData(
      context.queryClient,
      timeReportOptions(
        context.user.activeOrganizationId,
        context.user.id,
        resolveReportSearch(deps, todayIn(context.user.timezoneId)).filter,
      ),
    );
  },
  head: () => ({ meta: [{ title: pageTitle("billing.timeReport.title") }] }),
  pendingComponent: TimeReportPending,
  component: TimeReportPage,
});

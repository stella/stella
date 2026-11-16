import { createFileRoute, redirect } from "@tanstack/react-router";

import { Temporal } from "@stll/time";

import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";
import { ensureRouteQueryData } from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";

import {
  ReportLayout,
  ReportPage,
} from "./_protected.time_.report/-components/report-page";
import { timeReportOptions } from "./_protected.time_.report/-components/report-query";
import { reportSearchSchema } from "./_protected.time_.report/-components/report-search";
import { resolveReportSearch } from "./_protected.time_.report/-components/report.logic";

const TimeReportRoute = () => {
  const search = Route.useSearch({ select: (value) => value });
  const { organizationId, userId, timezoneId } = Route.useRouteContext({
    select: (context) => ({
      organizationId: context.user.activeOrganizationId,
      userId: context.user.id,
      timezoneId: context.user.timezoneId,
    }),
  });
  const navigate = Route.useNavigate();
  const { filter, period } = resolveReportSearch(
    search,
    Temporal.Now.plainDateISO(timezoneId).toString(),
  );
  return (
    <ReportPage
      organizationId={organizationId}
      userId={userId}
      filter={filter}
      period={period}
      onChange={(next, nextPeriod) =>
        detached(
          navigate({ search: { ...next, period: nextPeriod } }),
          "time-report.navigate",
        )
      }
    />
  );
};

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
        resolveReportSearch(
          deps,
          Temporal.Now.plainDateISO(context.user.timezoneId).toString(),
        ).filter,
      ),
    );
  },
  head: () => ({ meta: [{ title: pageTitle("billing.timeReport.title") }] }),
  pendingComponent: () => (
    <ReportLayout
      data={undefined}
      filter={{
        from: "2000-01-03",
        to: "2000-01-09",
        groupBy: "member",
        bucket: "day",
      }}
      period="week"
      onChange={() => undefined}
    />
  ),
  component: TimeReportRoute,
});

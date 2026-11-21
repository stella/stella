import { createFileRoute, redirect } from "@tanstack/react-router";

import { todayIn, weekOf } from "@/components/billing/work-week.logic";
import { timeApprovalsSearchSchema } from "@/features/time-review/time-approvals-search";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { pageTitle } from "@/lib/page-title";
import { routeLoadMode } from "@/lib/query-view.logic";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import { timeApprovalsQuery } from "@/lib/workspaces/queries/time-approvals";
import { routePresentation } from "@/routes/-route-presentation";

import { TimeApprovalsRoute } from "./-time-approvals.page";
import { TimeApprovalsPending } from "./-time-approvals.pending";

export const Route = createFileRoute("/_protected/time_/approvals")({
  validateSearch: timeApprovalsSearchSchema,
  staticData: {
    presentation: routePresentation(
      {
        type: "label",
        labelKey: "billing.approval.title",
        to: "/time/approvals",
      },
      {
        type: "label",
        labelKey: "billing.timesheets",
        to: "/time",
      },
    ),
  },
  loaderDeps: ({ search }) => ({
    date: search.date,
    member: search.member,
    matter: search.matter,
  }),
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
  loader: async ({ cause, context, deps }) => {
    const date = deps.date ?? todayIn(context.user.timezoneId);
    const options = timeApprovalsQuery(
      context.user.activeOrganizationId,
      context.user.id,
      weekOf(date),
      deps,
    );
    if (
      routeLoadMode({
        cause,
        hasCachedPages:
          context.queryClient.getQueryData(options.queryKey) !== undefined,
      }) === "await"
    ) {
      await ensureRouteInfiniteQueryData(context.queryClient, options);
    }
  },
  head: () => ({ meta: [{ title: pageTitle("billing.approval.title") }] }),
  pendingComponent: TimeApprovalsPending,
  component: TimeApprovalsRoute,
});

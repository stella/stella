import { createFileRoute, redirect } from "@tanstack/react-router";

import { Temporal } from "@stll/time";
import { Skeleton } from "@stll/ui/skeleton";

import { weekOf } from "@/components/billing/work-week.logic";
import {
  TimeApprovalsPage,
  timeApprovalsQuery,
} from "@/features/time-review/time-approvals-page";
import { timeApprovalsSearchSchema } from "@/features/time-review/time-approvals-search";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";

const todayIn = (timezoneId: string) =>
  Temporal.Now.plainDateISO(timezoneId).toString();

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
  loader: async ({ context, deps }) => {
    const date = deps.date ?? todayIn(context.user.timezoneId);
    await ensureRouteInfiniteQueryData(
      context.queryClient,
      timeApprovalsQuery(
        context.user.activeOrganizationId,
        context.user.id,
        weekOf(date),
        { member: deps.member, matter: deps.matter },
      ),
    );
  },
  head: () => ({ meta: [{ title: pageTitle("billing.approval.title") }] }),
  pendingComponent: TimeApprovalsPending,
  component: TimeApprovalsRoute,
});

function TimeApprovalsPending() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-11 w-64" />
      </div>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 p-4">
        <Skeleton className="h-5 w-48" />
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton className="h-24 w-full rounded-md" key={index} />
        ))}
      </div>
    </div>
  );
}

function TimeApprovalsRoute() {
  const search = Route.useSearch({
    select: ({ date, member, matter }) => ({ date, member, matter }),
  });
  const { organizationId, userId, timezoneId } = Route.useRouteContext({
    select: (context) => ({
      organizationId: context.user.activeOrganizationId,
      userId: context.user.id,
      timezoneId: context.user.timezoneId,
    }),
  });
  const navigate = Route.useNavigate();

  return (
    <TimeApprovalsPage
      filter={{
        date: search.date ?? todayIn(timezoneId),
        member: search.member,
        matter: search.matter,
      }}
      onFilterChange={(filter) =>
        detached(
          navigate({
            search: {
              date: filter.date,
              ...(filter.member === undefined ? {} : { member: filter.member }),
              ...(filter.matter === undefined ? {} : { matter: filter.matter }),
            },
          }),
          "time-approvals.navigate",
        )
      }
      onThisWeek={() =>
        detached(navigate({ search: {} }), "time-approvals.this-week")
      }
      organizationId={organizationId}
      userId={userId}
    />
  );
}

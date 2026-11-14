import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { parsePlainDate, Temporal } from "@stll/time";
import { Skeleton } from "@stll/ui/skeleton";

import { MyWeek, myWeekQueries } from "@/features/my-week/my-week";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import { routeSearchSchema } from "@/route-search-params";
import { routePresentation } from "@/routes/-route-presentation";

/** Today in the person's own zone, which also bounds the week's activity. */
const todayIn = (timezoneId: string) =>
  Temporal.Now.plainDateISO(timezoneId).toString();

export const Route = createFileRoute("/_protected/time")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "billing.timesheets",
      to: "/time",
    }),
  },
  validateSearch: routeSearchSchema({
    date: v.optional(
      v.pipe(
        v.string(),
        v.check((date) => parsePlainDate(date) !== null),
      ),
    ),
  }),
  loaderDeps: ({ search }) => ({ date: search.date }),
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
    const { timezoneId } = context.user;
    const queries = myWeekQueries({
      organizationId: context.user.activeOrganizationId,
      userId: context.user.id,
      timezoneId,
      date: deps.date ?? todayIn(timezoneId),
    });
    await Promise.all([
      ensureRouteInfiniteQueryData(context.queryClient, queries.entries),
      ensureRouteQueryData(context.queryClient, queries.suggestions),
    ]);
  },
  pendingComponent: MyWeekPending,
  component: MyWeekPage,
  head: () => ({ meta: [{ title: pageTitle("billing.timesheets") }] }),
});

function MyWeekPending() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-11 w-64" />
      </div>
      <div className="grid grid-cols-7 gap-1 border-b px-4 py-2">
        {Array.from({ length: 7 }, (_, index) => (
          <Skeleton className="h-14 rounded-md" key={index} />
        ))}
      </div>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 p-4">
        <Skeleton className="h-5 w-48" />
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton className="h-14 w-full rounded-lg" key={index} />
        ))}
      </div>
    </div>
  );
}

function MyWeekPage() {
  const searchDate = Route.useSearch({ select: (search) => search.date });
  const { organizationId, userId, timezoneId } = Route.useRouteContext({
    select: (context) => ({
      organizationId: context.user.activeOrganizationId,
      userId: context.user.id,
      timezoneId: context.user.timezoneId,
    }),
  });
  const navigate = Route.useNavigate();

  return (
    <MyWeek
      date={searchDate ?? todayIn(timezoneId)}
      onSelectDate={(date) =>
        detached(navigate({ search: { date } }), "my-week.navigate")
      }
      onToday={() => detached(navigate({ search: {} }), "my-week.today")}
      organizationId={organizationId}
      timezoneId={timezoneId}
      userId={userId}
    />
  );
}

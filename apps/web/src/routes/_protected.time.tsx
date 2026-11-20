import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { parsePlainDate } from "@stll/time";

import { todayIn, weekOf } from "@/components/billing/work-week.logic";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { pageTitle } from "@/lib/page-title";
import { routeLoadMode } from "@/lib/query-view.logic";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import { myTimeEntriesInfiniteOptions } from "@/lib/workspaces/queries/my-time-entries";
import { myTimeSuggestionsOptions } from "@/lib/workspaces/queries/my-time-suggestions";
import { routeSearchSchema } from "@/route-search-params";
import { routePresentation } from "@/routes/-route-presentation";

import { MyWeekPage } from "./-my-week.page";
import { MyWeekPending } from "./-my-week.pending";

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
  loader: async ({ cause, context, deps }) => {
    const {
      activeOrganizationId: organizationId,
      id: userId,
      timezoneId,
    } = context.user;
    const week = weekOf(deps.date ?? todayIn(timezoneId));
    const range = { startDate: week.start, endDate: week.end };
    const entries = myTimeEntriesInfiniteOptions(organizationId, userId, range);
    const suggestions = myTimeSuggestionsOptions(organizationId, userId, {
      ...range,
      timezoneId,
    });
    let hasCachedPages = true;
    for (const options of [entries, suggestions]) {
      if (context.queryClient.getQueryData(options.queryKey) === undefined) {
        hasCachedPages = false;
        break;
      }
    }
    if (routeLoadMode({ cause, hasCachedPages }) === "background") {
      return;
    }
    await Promise.all([
      ensureRouteInfiniteQueryData(context.queryClient, entries),
      ensureRouteQueryData(context.queryClient, suggestions),
    ]);
  },
  pendingComponent: MyWeekPending,
  component: MyWeekPage,
  head: () => ({ meta: [{ title: pageTitle("billing.timesheets") }] }),
});

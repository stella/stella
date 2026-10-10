import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useFormatter, useTranslations } from "use-intl";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { parsePlainDate, Temporal } from "@stll/time";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronLeftIcon, ChevronRightIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";

import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { localISODate } from "@/lib/local-iso-date";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import { MEDIUM_DATE_FORMAT } from "@/lib/relative-time";
import { formatMinutes } from "@/lib/workspaces/format-duration";
import { myTimeEntriesInfiniteOptions } from "@/lib/workspaces/queries/my-time-entries";

export const Route = createFileRoute("/_protected/time")({
  validateSearch: (search) => ({
    date:
      typeof search["date"] === "string" &&
      parsePlainDate(search["date"]) !== null
        ? search["date"]
        : localISODate(),
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
    await ensureRouteInfiniteQueryData(
      context.queryClient,
      myTimeEntriesInfiniteOptions(
        context.user.activeOrganizationId,
        context.user.id,
        deps.date,
      ),
    );
  },
  pendingComponent: MyDayPending,
  component: MyDayPage,
});

function MyDayPending() {
  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <Skeleton className="h-10 w-full max-w-80" />
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton className="h-16 w-full rounded-lg" key={index} />
      ))}
    </div>
  );
}

function MyDayPage() {
  const tBilling = useTranslations("billing");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const tDay = useTranslations("timesheets.day");
  const format = useFormatter();
  const date = Route.useSearch({ select: (search) => search.date });
  const organizationId = Route.useRouteContext({
    select: (context) => context.user.activeOrganizationId,
  });
  const userId = Route.useRouteContext({
    select: (context) => context.user.id,
  });
  const navigate = Route.useNavigate();
  const entriesQuery = useSuspenseInfiniteQuery(
    myTimeEntriesInfiniteOptions(organizationId, userId, date),
  );
  const entries = entriesQuery.data.pages.flatMap((page) => page.items);
  const totalMinutes = entries.reduce(
    (sum, entry) =>
      sum + (entry.timerStartedAt === null ? entry.durationMinutes : 0),
    0,
  );
  const hasRunningEntry = entries.some(
    (entry) => entry.timerStartedAt !== null,
  );
  const moveDay = (days: number) => {
    const nextDate = Temporal.PlainDate.from(date).add({ days }).toString();
    detached(navigate({ search: { date: nextDate } }), "my-day.navigate");
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <h1 className="text-sm font-medium">{tBilling("timesheets")}</h1>
        <div className="flex items-center gap-2">
          <Button
            onClick={() =>
              detached(
                navigate({ search: { date: localISODate() } }),
                "my-day.navigate",
              )
            }
            size="sm"
            variant="outline"
          >
            {tCommon("today")}
          </Button>
          <Button
            aria-label={tCommon("previous")}
            className="size-11"
            onClick={() => moveDay(-1)}
            size="icon"
            variant="ghost"
          >
            <DirectionalIcon className="size-4" icon={ChevronLeftIcon} />
          </Button>
          <span className="min-w-36 text-center text-sm">
            {format.dateTime(
              Temporal.PlainDate.from(date).toZonedDateTime({
                plainTime: Temporal.PlainTime.from("00:00"),
                timeZone: "UTC",
              }).epochMilliseconds,
              { ...MEDIUM_DATE_FORMAT, timeZone: "UTC" },
            )}
          </span>
          <Button
            aria-label={tCommon("next")}
            className="size-11"
            onClick={() => moveDay(1)}
            size="icon"
            variant="ghost"
          >
            <DirectionalIcon className="size-4" icon={ChevronRightIcon} />
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-4xl space-y-3 p-4">
          {entries.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">
              {tBilling("noEntries")}
            </p>
          ) : (
            <>
              {!entriesQuery.hasNextPage && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {tBilling("total")}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-medium tabular-nums">
                      {formatMinutes(totalMinutes)}
                    </span>
                    {hasRunningEntry && (
                      <span className="text-muted-foreground">
                        {tCommon("running")}
                      </span>
                    )}
                  </span>
                </div>
              )}
              <ul className="divide-y rounded-lg border">
                {entries.map((entry) => (
                  <li
                    className="flex flex-wrap items-start justify-between gap-3 p-4"
                    key={entry.id}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      {entry.activityGroup ===
                      TIME_ENTRY_ACTIVITY_GROUP.INTERNAL ? (
                        <span className="text-sm font-medium">
                          {tDay("internalWork")}
                        </span>
                      ) : (
                        <Link
                          className="hover:underline"
                          params={{ workspaceId: entry.workspaceId }}
                          to="/workspaces/$workspaceId/timesheets"
                        >
                          <BidiText as="span" className="text-sm font-medium">
                            {entry.workspaceName}
                          </BidiText>
                        </Link>
                      )}
                      {entry.activityGroup ===
                        TIME_ENTRY_ACTIVITY_GROUP.CLIENT &&
                        entry.workspaceReference && (
                          <BidiText
                            as="p"
                            className="text-muted-foreground text-xs"
                          >
                            {entry.workspaceReference}
                          </BidiText>
                        )}
                      {entry.narrative && (
                        <BidiText
                          as="p"
                          className="text-muted-foreground text-sm"
                        >
                          {entry.narrative}
                        </BidiText>
                      )}
                    </div>
                    <div className="space-y-1 text-end text-sm">
                      <p className="font-medium tabular-nums">
                        {entry.timerStartedAt === null
                          ? formatMinutes(entry.durationMinutes)
                          : tCommon("running")}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {tBilling(`statuses.${entry.status}`)}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {tBilling(entry.billable ? "billable" : "nonBillable")}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
              {entriesQuery.hasNextPage && (
                <div className="flex justify-center">
                  <Button
                    disabled={entriesQuery.isFetchingNextPage}
                    onClick={() =>
                      detached(entriesQuery.fetchNextPage(), "my-day.next-page")
                    }
                    size="sm"
                    variant="outline"
                  >
                    {tCommon("loadMore")}
                  </Button>
                </div>
              )}
              {entriesQuery.isFetchNextPageError && (
                <p
                  role="alert"
                  className="text-destructive text-center text-sm"
                >
                  {tErrors("actionFailed")}
                </p>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

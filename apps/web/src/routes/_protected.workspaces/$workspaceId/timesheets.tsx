import { lazy, Suspense, useState } from "react";

import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { BILLING_STATUS } from "@stll/api-contract";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronLeftIcon, ChevronRightIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";
import { Tabs, TabsList, TabsTab } from "@stll/ui/tabs";

import {
  getTimeEntryDateBounds,
  isTimeEntryDateAllowed,
} from "@/components/billing/time-entry-date.logic";
import { toISODate } from "@/components/workspaces/entity-utils";
import { usePermissions } from "@/hooks/use-permissions";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { useFormatter } from "@/i18n/formatting-context";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import { MEDIUM_DATE_FORMAT } from "@/lib/relative-time";
import { expensesOptions } from "@/lib/workspaces/queries/expenses";
import {
  timeEntriesInfiniteOptions,
  timeEntriesOptions,
  timeEntrySuggestionsOptions,
  timeEntrySummaryOptions,
} from "@/lib/workspaces/queries/time-entries";
import { routeSearchSchema } from "@/route-search-params";
import { MatterApprovalView } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/matter-approval-view";
import { PersonalTimesheetDay } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/personal-timesheet-day";

const RateManagementDialog = lazy(async () => {
  const module =
    await import("@/routes/_protected.workspaces/$workspaceId/-components/billing/rate-management-dialog");
  return { default: module.RateManagementDialog };
});

const BillingCodesDialog = lazy(async () => {
  const module =
    await import("@/routes/_protected.workspaces/$workspaceId/-components/billing/billing-codes-dialog");
  return { default: module.BillingCodesDialog };
});

/**
 * `view=approvals` opens the matter's approval queue, so the invoice composer
 * can link straight to the work that is waiting.
 */
const timesheetsSearchSchema = routeSearchSchema({
  view: v.optional(v.picklist(["approvals"])),
});

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/timesheets",
)({
  validateSearch: timesheetsSearchSchema,
  loaderDeps: ({ search }) => ({ view: search.view }),
  beforeLoad: async ({ context, params }) => {
    if (
      !(await isTimeBillingRouteEnabled(context.queryClient, {
        userId: context.user.id,
        organizationId: context.user.activeOrganizationId,
      }))
    ) {
      throw redirect({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: params.workspaceId },
      });
    }

    const role = await ensureRouteQueryData(context.queryClient, roleOptions);
    const canReadTimeEntries = authClient.organization.checkRolePermission({
      role,
      permissions: { timeEntry: ["read"] },
    });
    if (!canReadTimeEntries) {
      throw redirect({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: params.workspaceId },
      });
    }
  },
  loader: async ({ context, deps, params }) => {
    const role = await ensureRouteQueryData(context.queryClient, roleOptions);
    const opensApprovals =
      deps.view === "approvals" &&
      authClient.organization.checkRolePermission({
        role,
        permissions: { timeEntry: ["approve"] },
      });
    if (opensApprovals) {
      await Promise.all([
        ensureRouteQueryData(
          context.queryClient,
          timeEntriesOptions(params.workspaceId, context.user.id, {
            status: BILLING_STATUS.DRAFT,
          }),
        ),
        ensureRouteQueryData(
          context.queryClient,
          timeEntriesOptions(params.workspaceId, context.user.id, {
            status: BILLING_STATUS.APPROVED,
          }),
        ),
        ensureRouteQueryData(
          context.queryClient,
          expensesOptions(params.workspaceId, {
            status: BILLING_STATUS.DRAFT,
          }),
        ),
        ensureRouteQueryData(
          context.queryClient,
          expensesOptions(params.workspaceId, {
            status: BILLING_STATUS.APPROVED,
          }),
        ),
      ]);
      return;
    }
    const today = Temporal.Now.instant()
      .toZonedDateTimeISO(Temporal.Now.timeZoneId())
      .toPlainDate()
      .toString();
    await Promise.all([
      ensureRouteInfiniteQueryData(
        context.queryClient,
        timeEntriesInfiniteOptions(params.workspaceId, context.user.id, {
          dateFrom: today,
          dateTo: today,
          scope: "me",
        }),
      ),
      ensureRouteQueryData(
        context.queryClient,
        timeEntrySummaryOptions(
          params.workspaceId,
          context.user.id,
          today,
          today,
        ),
      ),
      ensureRouteQueryData(
        context.queryClient,
        timeEntrySuggestionsOptions(
          params.workspaceId,
          context.user.id,
          today,
          Temporal.Now.timeZoneId(),
        ),
      ),
    ]);
  },
  remountDeps: ({ params }) => params.workspaceId,
  component: TimesheetsPage,
});

const TimesheetSkeleton = () => (
  <div className="flex flex-col gap-3">
    <div className="flex min-h-11 items-center justify-between">
      <Skeleton className="h-5 w-20" />
      <Skeleton className="h-9 w-28" />
    </div>
    {Array.from({ length: 3 }, (_, index) => (
      <Skeleton className="h-14 w-full rounded-lg" key={index} />
    ))}
  </div>
);

function TimesheetsPage() {
  const tBilling = useTranslations("billing");
  const tCommon = useTranslations("common");
  const canManageRates = usePermissions({ rate: ["create"] });
  const canManageBillingCodes = usePermissions({ billingCode: ["create"] });
  const canApprove = usePermissions({ timeEntry: ["approve"] });
  const navigate = Route.useNavigate();
  const requestedView = Route.useSearch({ select: (search) => search.view });
  const view =
    canApprove && requestedView === "approvals" ? "approvals" : "personal";
  const [rateDialogOpen, setRateDialogOpen] = useState(false);
  const [codesDialogOpen, setCodesDialogOpen] = useState(false);
  const format = useFormatter();
  const workspaceId = Route.useParams({
    select: (params) => params.workspaceId,
  });
  const [date, setDate] = useState(() =>
    Temporal.Now.instant()
      .toZonedDateTimeISO(Temporal.Now.timeZoneId())
      .toPlainDate(),
  );
  const dateValue = toISODate(date);
  const dateBounds = getTimeEntryDateBounds();
  const canLogTime = isTimeEntryDateAllowed(dateValue, dateBounds);

  const moveDay = (days: number) => {
    setDate((current) => current.add({ days }));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <h1 className="text-sm font-medium">{tBilling("timesheets")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {canApprove && (
            <Tabs
              onValueChange={(next: typeof view) => {
                detached(
                  navigate({
                    search: next === "approvals" ? { view: next } : {},
                  }),
                  "timesheets.switch-view",
                );
              }}
              value={view}
            >
              <TabsList>
                <TabsTab value="personal">
                  {tBilling("approval.myTime")}
                </TabsTab>
                <TabsTab value="approvals">
                  {tBilling("approval.title")}
                </TabsTab>
              </TabsList>
            </Tabs>
          )}
          {canManageRates && (
            <Button
              onClick={() => setRateDialogOpen(true)}
              size="sm"
              variant="outline"
            >
              {tBilling("rates.rates")}
            </Button>
          )}
          {canManageBillingCodes && (
            <Button
              onClick={() => setCodesDialogOpen(true)}
              size="sm"
              variant="outline"
            >
              {tBilling("codes.manageCodes")}
            </Button>
          )}
          {view === "personal" && (
            <>
              <Button
                onClick={() =>
                  setDate(
                    Temporal.Now.instant()
                      .toZonedDateTimeISO(Temporal.Now.timeZoneId())
                      .toPlainDate(),
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
                  date.toZonedDateTime({
                    plainTime: Temporal.PlainTime.from("00:00"),
                    timeZone: "UTC",
                  }).epochMilliseconds,
                  { ...MEDIUM_DATE_FORMAT, timeZone: "UTC" },
                )}
              </span>
              <Button
                aria-label={tCommon("next")}
                className="size-11"
                disabled={
                  dateValue >=
                  toISODate(
                    Temporal.Now.instant()
                      .toZonedDateTimeISO(Temporal.Now.timeZoneId())
                      .toPlainDate(),
                  )
                }
                onClick={() => moveDay(1)}
                size="icon"
                variant="ghost"
              >
                <DirectionalIcon className="size-4" icon={ChevronRightIcon} />
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <Suspense fallback={<TimesheetSkeleton />}>
          {view === "personal" ? (
            <PersonalTimesheetDay
              canCreateTimeEntry={canLogTime}
              date={dateValue}
              key={dateValue}
              workspaceId={workspaceId}
            />
          ) : (
            <MatterApprovalView workspaceId={workspaceId} />
          )}
        </Suspense>
      </div>
      <Suspense fallback={null}>
        {rateDialogOpen && (
          <RateManagementDialog
            onOpenChange={setRateDialogOpen}
            open
            workspaceId={workspaceId}
          />
        )}
        {codesDialogOpen && (
          <BillingCodesDialog
            onOpenChange={setCodesDialogOpen}
            open
            workspaceId={workspaceId}
          />
        )}
      </Suspense>
    </div>
  );
}

import { lazy, Suspense, useState } from "react";

import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronLeftIcon, ChevronRightIcon } from "@stll/ui/icons";
import { Tabs, TabsList, TabsTab } from "@stll/ui/tabs";

import {
  getTimeEntryDateBounds,
  isTimeEntryDateAllowed,
} from "@/components/billing/time-entry-date.logic";
import { toISODate } from "@/components/workspaces/entity-utils";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { MEDIUM_DATE_FORMAT } from "@/lib/relative-time";
import { MatterApprovalView } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/matter-approval-view";
import { PersonalTimesheetDay } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/personal-timesheet-day";

import { MatterApprovalSkeleton } from "./-components/billing/matter-approval-view.pending";
import { PersonalTimesheetDaySkeleton } from "./-components/billing/personal-timesheet-day.pending";
import {
  MatterTimesheetsShell,
  TimesheetDayLabel,
} from "./-timesheets.pending";

const route = getRouteApi("/_protected/workspaces/$workspaceId/timesheets");

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

export function TimesheetsPage() {
  const tBilling = useTranslations("billing");
  const tCommon = useTranslations("common");
  const canManageRates = usePermissions({ rate: ["create"] });
  const canManageBillingCodes = usePermissions({ billingCode: ["create"] });
  const canApprove = usePermissions({ timeEntry: ["approve"] });
  const canCreate = usePermissions({ timeEntry: ["create"] });
  const navigate = route.useNavigate();
  const requestedView = route.useSearch({ select: (search) => search.view });
  const view =
    canApprove && requestedView === "approvals" ? "approvals" : "personal";
  const requestedRates = route.useSearch({ select: (search) => search.rates });
  const rateDialogOpen = requestedRates === "manage" && canManageRates;
  const setRateDialogOpen = (open: boolean) => {
    detached(
      navigate({
        search: (previous) => ({
          ...previous,
          rates: open ? "manage" : undefined,
        }),
      }),
      "timesheets.manage-rates",
    );
  };
  const [codesDialogOpen, setCodesDialogOpen] = useState(false);
  const format = useFormatter();
  const workspaceId = route.useParams({
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
    <MatterTimesheetsShell
      actions={
        <>
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
              <TimesheetDayLabel>
                {format.dateTime(
                  date.toZonedDateTime({
                    plainTime: Temporal.PlainTime.from("00:00"),
                    timeZone: "UTC",
                  }).epochMilliseconds,
                  { ...MEDIUM_DATE_FORMAT, timeZone: "UTC" },
                )}
              </TimesheetDayLabel>
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
        </>
      }
      dialogs={
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
      }
      title={tBilling("timesheets")}
    >
      <Suspense
        fallback={
          view === "personal" ? (
            <PersonalTimesheetDaySkeleton mayLogTime={canCreate} />
          ) : (
            <MatterApprovalSkeleton />
          )
        }
        key={view}
      >
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
    </MatterTimesheetsShell>
  );
}

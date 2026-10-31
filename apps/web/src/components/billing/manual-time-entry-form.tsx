import { type ReactNode, useId, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Form } from "@stll/ui/form";
import { Label } from "@stll/ui/label";

import { DurationInput } from "@/components/billing/duration-input";
import {
  getTimeEntryDateBounds,
  isTimeEntryDateAllowed,
} from "@/components/billing/time-entry-date.logic";
import { TimeEntryNarrativeField } from "@/components/billing/time-entry-narrative-field";
import { isTimeEntryRateRequired } from "@/components/billing/time-entry-rate-error.logic";
import { DatePickerPopover } from "@/components/date-picker-popover";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { MEDIUM_DATE_FORMAT } from "@/lib/relative-time";
import { resolvedRateOptions } from "@/lib/workspaces/queries/rates";

export type ManualTimeEntryValues = {
  dateWorked: string;
  durationMinutes: number;
  narrative: string;
  narrativeLanguage: string | null;
  billable: boolean;
};

type ManualTimeEntryFormProps = {
  defaultValues: ManualTimeEntryValues;
  /** The day is fixed by the caller (a suggestion belongs to its day). */
  dateLocked?: boolean;
  autofocusDuration?: boolean;
  narrativeRequired?: boolean;
  pending: boolean;
  workspaceId: string;
  userId: string;
  activityCode?: string | null;
  /** A field above the date, such as the entry's matter. */
  leading?: ReactNode;
  onCancel: () => void;
  onSubmit: (
    values: ManualTimeEntryValues,
  ) => Promise<void | Result<void, unknown>>;
  onSaveAndNew?: (
    values: ManualTimeEntryValues,
  ) => Promise<void | Result<void, unknown>>;
  onSaveAndAddExpense?: (
    values: ManualTimeEntryValues,
  ) => Promise<void | Result<void, unknown>>;
};

type TimeEntryRateOptions = {
  workspaceId: string;
  userId: string;
  activityCode: string | null | undefined;
  date: string;
  billable: boolean;
};

const useTimeEntryRate = ({
  workspaceId,
  userId,
  activityCode,
  date,
  billable,
}: TimeEntryRateOptions) => {
  const [rateRefusal, setRateRefusal] = useState<{
    workspaceId: string;
    userId: string;
    date: string;
    activityCode: string | null;
    dataUpdatedAt: number;
  } | null>(null);
  const rateQuery = useQuery({
    ...resolvedRateOptions({
      workspaceId,
      userId,
      date,
      activityCode: activityCode ?? "",
    }),
    enabled: billable && date.length > 0,
  });
  const missingRate =
    billable &&
    (rateQuery.data?.hourlyRate === null ||
      (rateRefusal?.workspaceId === workspaceId &&
        rateRefusal.userId === userId &&
        rateRefusal.date === date &&
        rateRefusal.activityCode === (activityCode ?? null) &&
        rateRefusal.dataUpdatedAt >= rateQuery.dataUpdatedAt));
  const rateReady = !billable || (rateQuery.isSuccess && !missingRate);

  const recordRefusal = () =>
    setRateRefusal({
      workspaceId,
      userId,
      date,
      activityCode: activityCode ?? null,
      dataUpdatedAt: rateQuery.dataUpdatedAt,
    });
  return { rateQuery, missingRate, rateReady, recordRefusal };
};

export const ManualTimeEntryForm = ({
  defaultValues,
  dateLocked = false,
  autofocusDuration = false,
  narrativeRequired = true,
  pending,
  workspaceId,
  userId,
  activityCode,
  leading,
  onCancel,
  onSubmit,
  onSaveAndNew,
  onSaveAndAddExpense,
}: ManualTimeEntryFormProps) => {
  const fieldId = useId();
  const tBilling = useTranslations("billing");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const format = useFormatter();
  const dateBounds = getTimeEntryDateBounds();
  const [dateWorked, setDateWorked] = useState(defaultValues.dateWorked);
  const [durationMinutes, setDurationMinutes] = useState(
    defaultValues.durationMinutes,
  );
  const [narrative, setNarrative] = useState(defaultValues.narrative);
  const [narrativeLanguage, setNarrativeLanguage] = useState(
    defaultValues.narrativeLanguage,
  );
  const [billable, setBillable] = useState(defaultValues.billable);

  const canManageRates = usePermissions({ rate: ["create"] });
  const { rateQuery, missingRate, rateReady, recordRefusal } = useTimeEntryRate(
    { workspaceId, userId, activityCode, date: dateWorked, billable },
  );

  const valid =
    rateReady &&
    dateWorked.length > 0 &&
    isTimeEntryDateAllowed(dateWorked, dateBounds) &&
    Number.isInteger(durationMinutes) &&
    durationMinutes > 0 &&
    (!narrativeRequired || narrative.trim().length > 0);

  const submit = (action: ManualTimeEntryFormProps["onSubmit"]) => {
    if (!valid || pending) {
      return;
    }
    detached(
      (async () => {
        const result = await action({
          dateWorked,
          durationMinutes,
          narrative: narrative.trim(),
          narrativeLanguage,
          billable,
        });
        if (result === undefined || Result.isOk(result)) {
          return;
        }
        if (isTimeEntryRateRequired(result.error)) {
          recordRefusal();
          return;
        }
        notifyUserError(result.error, tErrors("actionFailed"));
      })(),
      "manual-time-entry-form.submit",
    );
  };

  return (
    <Form
      dirty={
        dateWorked !== defaultValues.dateWorked ||
        durationMinutes !== defaultValues.durationMinutes ||
        narrative !== defaultValues.narrative ||
        narrativeLanguage !== defaultValues.narrativeLanguage ||
        billable !== defaultValues.billable
      }
      onDiscard={() => {
        setDateWorked(defaultValues.dateWorked);
        setDurationMinutes(defaultValues.durationMinutes);
        setNarrative(defaultValues.narrative);
        setNarrativeLanguage(defaultValues.narrativeLanguage);
        setBillable(defaultValues.billable);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        submit(onSubmit);
      }}
    >
      <fieldset className="flex min-w-0 flex-col gap-4" disabled={pending}>
        {leading}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label id={`${fieldId}-date-label`} htmlFor={`${fieldId}-date`}>
              {tCommon("date")}
            </Label>
            {dateLocked ? (
              <output
                aria-labelledby={`${fieldId}-date-label`}
                className="bg-muted flex min-h-11 items-center rounded-md border px-3 text-sm"
                id={`${fieldId}-date`}
              >
                {format.dateTime(
                  Temporal.PlainDate.from(dateWorked).toZonedDateTime({
                    plainTime: Temporal.PlainTime.from("00:00"),
                    timeZone: "UTC",
                  }).epochMilliseconds,
                  { ...MEDIUM_DATE_FORMAT, timeZone: "UTC" },
                )}
              </output>
            ) : (
              <DatePickerPopover
                id={`${fieldId}-date`}
                labelledBy={`${fieldId}-date-label`}
                maxDate={dateBounds.today}
                minDate={dateBounds.earliestDate}
                onChange={(value) => setDateWorked(value ?? "")}
                value={dateWorked}
              />
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label id={`${fieldId}-duration-label`}>
              {tBilling("duration")}
            </Label>
            <DurationInput
              autoFocus={autofocusDuration}
              id={`${fieldId}-duration`}
              labelledBy={`${fieldId}-duration-label`}
              onChange={setDurationMinutes}
              value={durationMinutes}
            />
          </div>
        </div>

        <TimeEntryNarrativeField
          required={narrativeRequired}
          id={`${fieldId}-narrative`}
          onChange={setNarrative}
          onLanguageChange={setNarrativeLanguage}
          narrativeLanguage={narrativeLanguage}
          value={narrative}
          workspaceId={workspaceId}
        />

        <div className="flex min-h-11 items-center gap-2">
          <Checkbox
            aria-describedby={missingRate ? `${fieldId}-rate-error` : undefined}
            aria-invalid={missingRate}
            checked={billable}
            id={`${fieldId}-billable`}
            onCheckedChange={setBillable}
          />
          <Label htmlFor={`${fieldId}-billable`}>{tBilling("billable")}</Label>
        </div>
        {billable && <QueryViewFeedback view={queryView(rateQuery)} />}
        {missingRate && (
          <div
            className="flex flex-col gap-2"
            role="alert"
            id={`${fieldId}-rate-error`}
          >
            <p className="text-destructive text-sm">
              {tBilling("rates.effectiveRateRequired")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setBillable(false)}
              >
                {tBilling("rates.logNonBillable")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  detached(
                    rateQuery.refetch(),
                    "manual-time-entry-form.retry-rate",
                  )
                }
              >
                {tCommon("retry")}
              </Button>
              {canManageRates && (
                <Button
                  variant="outline"
                  render={
                    <Link
                      to="/workspaces/$workspaceId/timesheets"
                      params={{ workspaceId }}
                      search={{ rates: "manage" }}
                    />
                  }
                >
                  {tBilling("rates.addRate")}
                </Button>
              )}
            </div>
          </div>
        )}
      </fieldset>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          disabled={pending}
          onClick={onCancel}
          type="button"
          variant="ghost"
        >
          {tCommon("cancel")}
        </Button>
        {onSaveAndNew && (
          <Button
            disabled={!valid || pending}
            onClick={() => submit(onSaveAndNew)}
            type="button"
            variant="outline"
          >
            {tBilling("quickEntry.saveAndNew")}
          </Button>
        )}
        {onSaveAndAddExpense && (
          <Button
            disabled={!valid || pending}
            onClick={() => submit(onSaveAndAddExpense)}
            type="button"
            variant="outline"
          >
            {tBilling("quickEntry.saveAndAddExpense")}
          </Button>
        )}
        <Button disabled={!valid || pending} type="submit">
          {tCommon("save")}
        </Button>
      </div>
    </Form>
  );
};

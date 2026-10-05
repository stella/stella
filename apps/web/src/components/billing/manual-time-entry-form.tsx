import { useId, useState } from "react";

import { useFormatter, useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { DialogFormState } from "@stll/ui/dialog";
import { Label } from "@stll/ui/label";

import { DurationInput } from "@/components/billing/duration-input";
import {
  getTimeEntryDateBounds,
  isTimeEntryDateAllowed,
} from "@/components/billing/time-entry-date.logic";
import { TimeEntryNarrativeField } from "@/components/billing/time-entry-narrative-field";
import { DatePickerPopover } from "@/components/date-picker-popover";
import { detached } from "@/lib/detached";
import { MEDIUM_DATE_FORMAT } from "@/lib/relative-time";

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
  onCancel: () => void;
  onSubmit: (values: ManualTimeEntryValues) => Promise<void>;
  onSaveAndNew?: (values: ManualTimeEntryValues) => Promise<void>;
  onSaveAndAddExpense?: (values: ManualTimeEntryValues) => Promise<void>;
};

export const ManualTimeEntryForm = ({
  defaultValues,
  dateLocked = false,
  autofocusDuration = false,
  narrativeRequired = true,
  pending,
  workspaceId,
  onCancel,
  onSubmit,
  onSaveAndNew,
  onSaveAndAddExpense,
}: ManualTimeEntryFormProps) => {
  const fieldId = useId();
  const tBilling = useTranslations("billing");
  const tCommon = useTranslations("common");
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

  const valid =
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
      action({
        dateWorked,
        durationMinutes,
        narrative: narrative.trim(),
        narrativeLanguage,
        billable,
      }),
      "manual-time-entry-form.submit",
    );
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit(onSubmit);
      }}
    >
      <DialogFormState
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
      />
      <fieldset className="flex min-w-0 flex-col gap-4" disabled={pending}>
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
            checked={billable}
            id={`${fieldId}-billable`}
            onCheckedChange={setBillable}
          />
          <Label htmlFor={`${fieldId}-billable`}>{tBilling("billable")}</Label>
        </div>
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
    </form>
  );
};

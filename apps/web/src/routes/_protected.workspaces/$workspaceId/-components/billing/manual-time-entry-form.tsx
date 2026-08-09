import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { Label } from "@stll/ui/components/label";

import { DatePickerPopover } from "@/components/date-picker-popover";
import { detached } from "@/lib/detached";
import { addDays, parseIsoDateLocal } from "@/lib/dates";
import { localISODate } from "@/lib/local-iso-date";
import { DurationInput } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/duration-input";
import { TimeEntryNarrativeField } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/time-entry-narrative-field";

export type ManualTimeEntryValues = {
  dateWorked: string;
  durationMinutes: number;
  narrative: string;
  billable: boolean;
};

type ManualTimeEntryFormProps = {
  defaultValues: ManualTimeEntryValues;
  pending: boolean;
  workspaceId: string;
  onCancel: () => void;
  onSubmit: (values: ManualTimeEntryValues) => Promise<void>;
};

export const ManualTimeEntryForm = ({
  defaultValues,
  pending,
  workspaceId,
  onCancel,
  onSubmit,
}: ManualTimeEntryFormProps) => {
  const tBilling = useTranslations("billing");
  const tCommon = useTranslations("common");
  const today = localISODate();
  const earliestDate = localISODate(
    addDays(parseIsoDateLocal(today) ?? new Date(), -90),
  );
  const [dateWorked, setDateWorked] = useState(defaultValues.dateWorked);
  const [durationMinutes, setDurationMinutes] = useState(
    defaultValues.durationMinutes,
  );
  const [narrative, setNarrative] = useState(defaultValues.narrative);
  const [billable, setBillable] = useState(defaultValues.billable);

  const valid =
    dateWorked.length > 0 &&
    Number.isInteger(durationMinutes) &&
    durationMinutes > 0 &&
    narrative.trim().length > 0;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || pending) {
          return;
        }
        detached(
          onSubmit({
            dateWorked,
            durationMinutes,
            narrative: narrative.trim(),
            billable,
          }),
          "ManualTimeEntryForm",
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label id="time-entry-date-label" htmlFor="time-entry-date">
            {tCommon("date")}
          </Label>
          <DatePickerPopover
            id="time-entry-date"
            labelledBy="time-entry-date-label"
            maxDate={today}
            minDate={earliestDate}
            onChange={(value) => setDateWorked(value ?? "")}
            value={dateWorked}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label id="time-entry-duration-label">{tBilling("duration")}</Label>
          <DurationInput
            id="time-entry-duration"
            labelledBy="time-entry-duration-label"
            onChange={setDurationMinutes}
            value={durationMinutes}
          />
        </div>
      </div>

      <TimeEntryNarrativeField
        id="time-entry-narrative"
        onChange={setNarrative}
        value={narrative}
        workspaceId={workspaceId}
      />

      <div className="flex min-h-11 items-center gap-2">
        <Checkbox
          checked={billable}
          id="time-entry-billable"
          onCheckedChange={setBillable}
        />
        <Label htmlFor="time-entry-billable">{tBilling("billable")}</Label>
      </div>

      <div className="flex justify-end gap-2">
        <Button
          disabled={pending}
          onClick={onCancel}
          type="button"
          variant="ghost"
        >
          {tCommon("cancel")}
        </Button>
        <Button disabled={!valid || pending} type="submit">
          {tCommon("save")}
        </Button>
      </div>
    </form>
  );
};

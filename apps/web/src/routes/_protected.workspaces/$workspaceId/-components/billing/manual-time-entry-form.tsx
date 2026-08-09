import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import { Textarea } from "@stll/ui/components/textarea";

import { DatePickerPopover } from "@/components/date-picker-popover";
import { detached } from "@/lib/detached";

export type ManualTimeEntryValues = {
  dateWorked: string;
  durationMinutes: number;
  narrative: string;
  billable: boolean;
};

type ManualTimeEntryFormProps = {
  defaultValues: ManualTimeEntryValues;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (values: ManualTimeEntryValues) => Promise<void>;
};

export const ManualTimeEntryForm = ({
  defaultValues,
  pending,
  onCancel,
  onSubmit,
}: ManualTimeEntryFormProps) => {
  const t = useTranslations();
  const [dateWorked, setDateWorked] = useState(defaultValues.dateWorked);
  const [durationMinutes, setDurationMinutes] = useState(
    defaultValues.durationMinutes > 0
      ? String(defaultValues.durationMinutes)
      : "",
  );
  const [narrative, setNarrative] = useState(defaultValues.narrative);
  const [billable, setBillable] = useState(defaultValues.billable);

  const parsedDuration = Number(durationMinutes);
  const valid =
    dateWorked.length > 0 &&
    Number.isInteger(parsedDuration) &&
    parsedDuration > 0 &&
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
            durationMinutes: parsedDuration,
            narrative: narrative.trim(),
            billable,
          }),
          "ManualTimeEntryForm",
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="time-entry-date">{t("common.date")}</Label>
          <DatePickerPopover
            id="time-entry-date"
            onChange={(value) => setDateWorked(value ?? "")}
            value={dateWorked}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="time-entry-duration">{t("billing.duration")}</Label>
          <Input
            id="time-entry-duration"
            inputMode="numeric"
            min={1}
            onChange={(event) => setDurationMinutes(event.currentTarget.value)}
            required
            type="number"
            value={durationMinutes}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="time-entry-narrative">{t("common.description")}</Label>
        <Textarea
          dir="auto"
          id="time-entry-narrative"
          maxLength={10_000}
          onChange={(event) => setNarrative(event.currentTarget.value)}
          placeholder={t("billing.narrativePlaceholder")}
          required
          rows={4}
          value={narrative}
        />
      </div>

      <div className="flex min-h-11 items-center gap-2">
        <Checkbox
          checked={billable}
          id="time-entry-billable"
          onCheckedChange={setBillable}
        />
        <Label htmlFor="time-entry-billable">{t("billing.billable")}</Label>
      </div>

      <div className="flex justify-end gap-2">
        <Button
          disabled={pending}
          onClick={onCancel}
          type="button"
          variant="ghost"
        >
          {t("common.cancel")}
        </Button>
        <Button disabled={!valid || pending} type="submit">
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
};

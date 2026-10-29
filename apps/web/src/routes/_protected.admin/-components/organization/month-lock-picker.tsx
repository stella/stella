import { useState } from "react";

import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { NumberInput } from "@stll/ui/number-input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { useFormatter } from "@/i18n/formatting-context";

type MonthLockPickerProps = {
  id: string;
  describedBy: string;
  disabled: boolean;
  value: string;
  today: Temporal.PlainDate;
  onChange: (value: string) => void;
};

export const MonthLockPicker = ({
  id,
  describedBy,
  disabled,
  value,
  today,
  onChange,
}: MonthLockPickerProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const previousMonth = today.subtract({ months: 1 });
  const [year, setYear] = useState(
    value === "" ? String(previousMonth.year) : value.slice(0, 4),
  );
  const month = value === "" ? null : value.slice(-2);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Select
        disabled={disabled}
        value={month}
        onValueChange={(next) => {
          if (next === null) {
            return;
          }
          onChange(`${year.padStart(4, "0")}-${next}`);
        }}
      >
        <SelectTrigger
          id={id}
          className="min-h-11"
          aria-describedby={describedBy}
          aria-label={t("workspaces.views.calendar.month")}
        >
          <SelectValue placeholder={t("workspaces.views.calendar.month")} />
        </SelectTrigger>
        <SelectPopup>
          {Array.from({ length: 12 }, (_, index) => {
            const monthNumber = index + 1;
            const monthValue = String(monthNumber).padStart(2, "0");
            const date = Temporal.PlainDate.from({
              year: previousMonth.year,
              month: monthNumber,
              day: 1,
            }).toZonedDateTime({ timeZone: "UTC", plainTime: "00:00" });
            return (
              <SelectItem
                disabled={
                  Number(year) > previousMonth.year ||
                  (Number(year) === previousMonth.year &&
                    monthNumber > previousMonth.month)
                }
                key={monthValue}
                value={monthValue}
              >
                {format.dateTime(date.epochMilliseconds, {
                  month: "long",
                  timeZone: "UTC",
                })}
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
      <NumberInput
        className="min-h-11 w-28"
        disabled={disabled}
        // A year reads without a thousands separator.
        format={{ useGrouping: false }}
        inputProps={{
          "aria-describedby": describedBy,
          "aria-label": t("workspaces.views.calendar.year"),
        }}
        max={previousMonth.year}
        min={1}
        onValueChange={(next) => {
          const nextYear = next === null ? "" : String(next);
          setYear(nextYear);
          if (month !== null) {
            onChange(`${nextYear.padStart(4, "0")}-${month}`);
          }
        }}
        required={month !== null}
        step={1}
        value={year === "" ? null : Number(year)}
      />
    </div>
  );
};

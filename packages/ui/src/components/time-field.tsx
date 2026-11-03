"use client";

import { useId, useMemo } from "react";

import { cn } from "../lib/utils";
import {
  getHourOptions,
  getMinuteOptions,
  getTimeFieldNames,
  type PickerClock,
  type PickerTimeOption,
  splitPickerTime,
} from "./date-picker-popover.logic";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./select";

type TimeFieldProps = {
  className?: string;
  disabled: boolean;
  /** Ties the field to an error or hint shown next to it. */
  describedBy?: string | undefined;
  invalid?: boolean;
  label: string;
  locale: string;
  onChange: (clock: PickerClock) => void;
  /** A wall-clock `HH:mm` time, or `null` while there is none. */
  time: string | null;
};

/**
 * A wall-clock time to the minute: hour and minute selects in the locale's
 * own clock and numerals, so `2 PM` and `14` read as each locale writes them.
 */
const TimeField = ({
  className,
  describedBy,
  disabled,
  invalid = false,
  label,
  locale,
  onChange,
  time,
}: TimeFieldProps) => {
  const labelId = useId();
  const hourOptions = useMemo(() => getHourOptions(locale), [locale]);
  const minuteOptions = useMemo(() => getMinuteOptions(locale), [locale]);
  const fieldNames = useMemo(() => getTimeFieldNames(locale), [locale]);
  const clock = time === null ? null : splitPickerTime(time);

  return (
    <div
      aria-describedby={describedBy}
      aria-labelledby={labelId}
      className={cn("flex items-center gap-1.5", className)}
      role="group"
    >
      <span className="text-foreground-label shrink-0 text-xs" id={labelId}>
        {label}
      </span>
      <TimePartSelect
        disabled={disabled}
        invalid={invalid}
        label={fieldNames.hour}
        onChange={(hour) => onChange({ hour, minute: clock?.minute ?? 0 })}
        options={hourOptions}
        value={clock?.hour ?? null}
      />
      <span aria-hidden="true" className="text-muted-foreground text-xs">
        :
      </span>
      <TimePartSelect
        disabled={disabled}
        invalid={invalid}
        label={fieldNames.minute}
        onChange={(minute) => onChange({ hour: clock?.hour ?? 0, minute })}
        options={minuteOptions}
        value={clock?.minute ?? null}
      />
    </div>
  );
};

const TimePartSelect = ({
  disabled,
  invalid,
  label,
  onChange,
  options,
  value,
}: {
  disabled: boolean;
  invalid: boolean;
  label: string;
  onChange: (value: number) => void;
  options: PickerTimeOption[];
  value: number | null;
}) => (
  <Select
    disabled={disabled}
    onValueChange={(next) => {
      if (typeof next === "number") {
        onChange(next);
      }
    }}
    value={value}
  >
    <SelectTrigger
      aria-invalid={invalid || undefined}
      aria-label={label}
      className="min-w-0 flex-1"
      size="sm"
    >
      <SelectValue placeholder={"—"} />
    </SelectTrigger>
    <SelectPopup>
      {options.map((option) => (
        <SelectItem key={option.value} value={option.value}>
          {option.label}
        </SelectItem>
      ))}
    </SelectPopup>
  </Select>
);

export { TimeField };
export type { TimeFieldProps };

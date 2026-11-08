"use client";

import { createContext, useContext, useId, useMemo } from "react";
import type * as React from "react";

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

/**
 * Label, hour, colon, minute. The time tracks never shrink below their value,
 * so a 12-hour `10 AM` is never clipped. Below 13rem, too narrow for the
 * longest label beside its selects, each label takes its own line above them.
 */
const TIME_FIELD_GRID_CLASS_NAME =
  "grid items-center gap-x-1.5 gap-y-1.5 " +
  "grid-cols-[auto_minmax(max-content,1fr)_auto_minmax(max-content,1fr)] " +
  "@max-[13rem]/time-fields:grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)]";

/** Set inside a TimeFieldGroup, whose grid every field's row shares. */
const TimeFieldGroupContext = createContext(false);

/**
 * Stacks time fields on one grid, so their labels, hours and minutes line up
 * whatever each label's length. A lone TimeField makes its own group.
 */
const TimeFieldGroup = ({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <TimeFieldGroupContext.Provider value={true}>
    <div className={cn("@container/time-fields min-w-0", className)} {...props}>
      <div className={TIME_FIELD_GRID_CLASS_NAME}>{children}</div>
    </div>
  </TimeFieldGroupContext.Provider>
);

type TimeFieldProps = {
  className?: string | undefined;
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
const TimeField = ({ className, ...props }: TimeFieldProps) => {
  const grouped = useContext(TimeFieldGroupContext);
  return grouped ? (
    <TimeFieldRow className={className} {...props} />
  ) : (
    <TimeFieldGroup className={className}>
      <TimeFieldRow {...props} />
    </TimeFieldGroup>
  );
};

const TimeFieldRow = ({
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
      className={cn(
        "col-span-full grid grid-cols-subgrid items-center",
        className,
      )}
      role="group"
    >
      <span
        className="text-foreground-label text-xs @max-[13rem]/time-fields:col-span-full"
        id={labelId}
      >
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
      // The shared trigger minimum would push the minutes past a narrow card;
      // the grid track sizes each select to its value instead.
      className="w-full min-w-0 tabular-nums"
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

export { TimeField, TimeFieldGroup };
export type { TimeFieldProps };

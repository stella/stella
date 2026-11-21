"use client";

import { useId, useRef, useState } from "react";

import { cn } from "../lib/utils";
import {
  DatePickerPopover,
  type DatePickerPopoverProps,
} from "./date-picker-popover";

type DateRangeFilterProps = Omit<
  DatePickerPopoverProps,
  | "value"
  | "onChange"
  | "minDate"
  | "open"
  | "defaultOpen"
  | "onOpenChange"
  | "triggerRef"
  | "focusTriggerOnOpen"
  | "id"
  | "labelledBy"
  | "mode"
> & {
  from: string | null;
  to: string | null;
  onFromChange: (value: string | null) => void;
  onToChange: (value: string | null) => void;
  fromLabel: string;
  toLabel: string;
};

type RangePickerState =
  | { type: "closed" }
  | { type: "from" }
  | { type: "to"; focus: "calendar" | "trigger" };

/** Both calendar bounds and the focus handoff belong to the range. */
const DateRangeFilter = ({
  from,
  to,
  onFromChange,
  onToChange,
  fromLabel,
  toLabel,
  className,
  maxDate,
  ...pickerProps
}: DateRangeFilterProps) => {
  const id = useId();
  const toRef = useRef<HTMLButtonElement>(null);
  const [picker, setPicker] = useState<RangePickerState>({ type: "closed" });
  const fromMax = to && (!maxDate || to < maxDate) ? to : maxDate;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span
          id={`${id}-from-label`}
          className="text-muted-foreground text-xs font-medium"
        >
          {fromLabel}
        </span>
        <DatePickerPopover
          {...pickerProps}
          mode="date"
          id={`${id}-from`}
          defaultOpen={false}
          labelledBy={`${id}-from-label`}
          dateInputLabel={fromLabel}
          value={from}
          maxDate={fromMax}
          minDate={undefined}
          triggerRef={undefined}
          focusTriggerOnOpen={false}
          open={picker.type === "from"}
          onOpenChange={(open) =>
            setPicker(open ? { type: "from" } : { type: "closed" })
          }
          onChange={(next) => {
            onFromChange(next);
            if (!next) {
              return;
            }
            setPicker({ type: "to", focus: "trigger" });
            toRef.current?.focus();
          }}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span
          id={`${id}-to-label`}
          className="text-muted-foreground text-xs font-medium"
        >
          {toLabel}
        </span>
        <DatePickerPopover
          {...pickerProps}
          mode="date"
          id={`${id}-to`}
          defaultOpen={false}
          labelledBy={`${id}-to-label`}
          dateInputLabel={toLabel}
          value={to}
          minDate={from ?? undefined}
          maxDate={maxDate}
          open={picker.type === "to"}
          triggerRef={toRef}
          focusTriggerOnOpen={
            picker.type === "to" && picker.focus === "trigger"
          }
          onOpenChange={(open) =>
            setPicker(
              open ? { type: "to", focus: "calendar" } : { type: "closed" },
            )
          }
          onChange={onToChange}
        />
      </div>
    </div>
  );
};

export { DateRangeFilter };
export type { DateRangeFilterProps };

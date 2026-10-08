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
  const [activeBound, setActiveBound] = useState<"from" | "to" | null>(null);
  const fromMax = to && (!maxDate || to < maxDate) ? to : maxDate;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex min-w-0 flex-col gap-1">
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
          open={activeBound === "from"}
          onOpenChange={(open) => setActiveBound(open ? "from" : null)}
          onChange={(next) => {
            onFromChange(next);
            if (!next) {
              return;
            }
            setActiveBound("to");
            toRef.current?.focus();
          }}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
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
          open={activeBound === "to"}
          triggerRef={toRef}
          focusTriggerOnOpen
          onOpenChange={(open) => setActiveBound(open ? "to" : null)}
          onChange={onToChange}
        />
      </div>
    </div>
  );
};

export { DateRangeFilter };
export type { DateRangeFilterProps };

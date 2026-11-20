import type { ReactNode } from "react";

import { FaceLabelPending } from "@stll/ui/control-face";
import { cn } from "@stll/ui/utils";

import type { Week } from "@/components/billing/work-week.logic";
import { PendingDate } from "@/components/pending-text";

export const WEEK_STRIP_DATE = {
  weekday: "short",
  day: "numeric",
  timeZone: "UTC",
} as const satisfies Intl.DateTimeFormatOptions;

export const WeekStripLayout = ({
  children,
  label,
}: {
  children: ReactNode;
  label?: string;
}) => (
  <nav aria-label={label} className="border-b px-4 py-2">
    <ol className="grid grid-cols-7 gap-1">{children}</ol>
  </nav>
);

export const WeekStripDay = ({
  date,
  durationLabel,
  pendingLabel,
  selected,
}: {
  date: ReactNode;
  durationLabel: ReactNode;
  pendingLabel: ReactNode;
  selected: boolean;
}) => (
  <span
    className={cn(
      "flex min-h-14 w-full flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-center select-none",
      selected
        ? "bg-muted text-foreground"
        : "text-muted-foreground group-hover/plain:bg-muted/60",
    )}
  >
    <span className="text-xs">{date}</span>
    <span className="text-foreground text-sm font-medium tabular-nums">
      {durationLabel}
    </span>
    <span className="text-xs tabular-nums">{pendingLabel}</span>
  </span>
);

const WEEK_DAY_OFFSETS = [0, 1, 2, 3, 4, 5, 6];

export const WeekStripSkeleton = ({
  week,
  selectedDate,
}: {
  week?: Week | undefined;
  selectedDate?: string | undefined;
}) => (
  <WeekStripLayout>
    {WEEK_DAY_OFFSETS.map((index) => {
      const date = week?.days.at(index);
      return (
        <li aria-hidden="true" key={index}>
          <WeekStripDay
            date={<PendingDate date={date} options={WEEK_STRIP_DATE} />}
            selected={date !== undefined && date === selectedDate}
            durationLabel={<FaceLabelPending className="w-8" />}
            pendingLabel={<FaceLabelPending className="w-12" />}
          />
        </li>
      );
    })}
  </WeekStripLayout>
);

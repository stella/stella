import type { ReactNode } from "react";

import { cn } from "../lib/utils";

type TimeEntryRowProps = {
  /** Leading control, e.g. a selection checkbox. */
  leading?: ReactNode;
  /** A glyph before the title, e.g. the matter icon. */
  icon?: ReactNode;
  /** The entry's name: its matter, or its description when it has no matter. */
  title: ReactNode;
  /** Badges after the title; keep them for states that need a look. */
  badges?: ReactNode;
  /** The muted line under the title: reference, sources, flags. */
  meta?: ReactNode;
  /** The duration, at the end of the title line. */
  duration: ReactNode;
  /** Controls after the duration, e.g. a billable switch or row actions. */
  trailing?: ReactNode;
  /** The description under the meta line, read-only or editable. */
  description?: ReactNode;
  /** Anything the row carries below its description. */
  children?: ReactNode;
  /** `card` frames the row on its own; `plain` sits in a divided list. */
  frame?: "card" | "plain";
  /** Dims a row the user left out. */
  inactive?: boolean;
};

/**
 * One time entry in a list: the timesheet's row. Its title line carries the
 * name and the duration; reference and description sit under it, muted, so
 * the hours and the matter are what the eye finds first.
 */
const TimeEntryRow = ({
  leading,
  icon,
  title,
  badges,
  meta,
  duration,
  trailing,
  description,
  children,
  frame = "card",
  inactive = false,
}: TimeEntryRowProps) => (
  <div
    className={cn(
      "flex min-h-14 items-start gap-3 px-3 py-2.5",
      frame === "card" && "rounded-lg border",
      inactive && "opacity-55",
    )}
    data-slot="time-entry-row"
  >
    {leading ? <div className="mt-0.5 flex shrink-0">{leading}</div> : null}
    <div className="min-w-0 flex-1">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm font-medium">
          {icon}
          {title}
          {badges}
        </div>
        <span className="shrink-0 text-sm tabular-nums">{duration}</span>
        {trailing ? (
          <div className="flex shrink-0 items-center gap-1">{trailing}</div>
        ) : null}
      </div>
      {meta ? (
        <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
          {meta}
        </div>
      ) : null}
      {description ? (
        <div className="text-muted-foreground mt-1 text-sm">{description}</div>
      ) : null}
      {children}
    </div>
  </div>
);

export { TimeEntryRow, type TimeEntryRowProps };

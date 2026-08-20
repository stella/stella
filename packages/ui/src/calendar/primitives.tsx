import type * as React from "react";

import { cn } from "../lib/utils";

export const CalendarGrid = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div className={cn("grid", className)} data-slot="calendar-grid" {...props} />
);

export const CalendarHeaderRow = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("grid border-b", className)}
    data-slot="calendar-header-row"
    {...props}
  />
);

export const CalendarHeaderCell = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "text-muted-foreground border-e px-2 py-2 text-center text-xs font-medium last:border-e-0",
      className,
    )}
    data-slot="calendar-header-cell"
    {...props}
  />
);

export const CalendarCell = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("border-e border-b", className)}
    data-slot="calendar-cell"
    {...props}
  />
);

export const CalendarEntryButton = ({
  className,
  ...props
}: React.ComponentProps<"button">) => (
  <button
    className={cn(
      "focus-visible:ring-ring min-w-0 rounded-md text-start text-xs outline-none focus-visible:ring-2",
      className,
    )}
    data-slot="calendar-entry"
    type="button"
    {...props}
  />
);

export const CalendarEntrySurface = ({
  className,
  ...props
}: React.ComponentProps<"article">) => (
  <article
    className={cn("min-w-0 rounded-md text-start text-xs", className)}
    data-slot="calendar-entry"
    {...props}
  />
);

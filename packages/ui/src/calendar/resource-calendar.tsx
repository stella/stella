import type { CSSProperties, ReactElement, ReactNode } from "react";

import { cn } from "../lib/utils";
import {
  CalendarCell,
  CalendarEntryButton,
  CalendarEntrySurface,
  CalendarHeaderCell,
  CalendarHeaderRow,
} from "./primitives";
import {
  assertConsecutiveCalendarDates,
  getResourceCalendarPlacement,
  nextCalendarDate,
} from "./resource-calendar.logic";

export type ResourceCalendarColumn = {
  date: string;
  label: ReactNode;
  meta?: ReactNode;
};

export type ResourceCalendarResource = {
  id: string;
  label: ReactNode;
  meta?: ReactNode;
};

export type ResourceCalendarEntryTone =
  | "accent"
  | "neutral"
  | "warning"
  | "destructive";

export type ResourceCalendarEntry = {
  accessibleLabel: string;
  endDateExclusive: string;
  id: string;
  label: ReactNode;
  meta?: ReactNode;
  resourceId: string;
  startDate: string;
  tone?: ResourceCalendarEntryTone;
};

type ResourceCalendarProps = {
  ariaLabel: string;
  columns: readonly ResourceCalendarColumn[];
  empty?: ReactNode;
  entries: readonly ResourceCalendarEntry[];
  onSelectEntry?: (entry: ResourceCalendarEntry) => void;
  resourceHeader: ReactNode;
  resources: readonly ResourceCalendarResource[];
};

export const ResourceCalendar = ({
  ariaLabel,
  columns,
  empty,
  entries,
  onSelectEntry,
  resourceHeader,
  resources,
}: ResourceCalendarProps): ReactElement => {
  assertResourceCalendarContract({ columns, entries, resources });

  if (resources.length === 0) {
    return <div data-slot="resource-calendar-empty">{empty}</div>;
  }

  const gridStyle = {
    gridTemplateColumns: `14rem repeat(${String(columns.length)}, minmax(7rem, 1fr))`,
  } satisfies CSSProperties;
  const visibleRange = {
    endDateExclusive: nextCalendarDate(columns.at(-1)?.date ?? ""),
    startDate: columns.at(0)?.date ?? "",
  };
  const entriesByResource = new Map<string, ResourceCalendarEntry[]>();
  for (const entry of entries) {
    const existing = entriesByResource.get(entry.resourceId);
    if (existing === undefined) {
      entriesByResource.set(entry.resourceId, [entry]);
      continue;
    }
    existing.push(entry);
  }

  return (
    <section
      aria-label={ariaLabel}
      className="border-border bg-card overflow-x-auto rounded-xl border"
      data-slot="resource-calendar"
    >
      <div className="min-w-max">
        <CalendarHeaderRow style={gridStyle}>
          <CalendarHeaderCell className="text-start font-semibold tracking-wide uppercase">
            {resourceHeader}
          </CalendarHeaderCell>
          {columns.map((column) => (
            <CalendarHeaderCell key={column.date}>
              <span className="block">{column.label}</span>
              {column.meta === undefined ? null : (
                <span className="text-foreground mt-0.5 block font-semibold">
                  {column.meta}
                </span>
              )}
            </CalendarHeaderCell>
          ))}
        </CalendarHeaderRow>

        {resources.map((resource) => {
          const resourceEntries = entriesByResource.get(resource.id) ?? [];

          return (
            <div
              className="border-border relative grid min-h-20 border-b last:border-b-0"
              data-slot="resource-calendar-row"
              key={resource.id}
              style={gridStyle}
            >
              <CalendarCell className="bg-card sticky start-0 z-10 border-b-0 px-4 py-3">
                <span className="block truncate text-sm font-semibold">
                  {resource.label}
                </span>
                {resource.meta === undefined ? null : (
                  <span className="text-muted-foreground mt-1 block truncate text-xs">
                    {resource.meta}
                  </span>
                )}
              </CalendarCell>
              {columns.map((column) => (
                <CalendarCell
                  className="bg-background/40 border-b-0 last:border-e-0"
                  key={column.date}
                />
              ))}
              {resourceEntries.map((entry) => {
                const placement = getResourceCalendarPlacement({
                  entry,
                  visibleRange,
                });
                if (placement === null) {
                  return null;
                }

                return (
                  <ResourceCalendarEntryView
                    entry={entry}
                    key={entry.id}
                    onSelectEntry={onSelectEntry}
                    placement={placement}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
};

const RESOURCE_CALENDAR_ENTRY_TONES = {
  accent: "bg-primary text-primary-foreground",
  destructive: "bg-destructive text-destructive-foreground",
  neutral: "border-border bg-muted text-foreground border",
  warning: "bg-warning text-warning-foreground",
} as const satisfies Record<ResourceCalendarEntryTone, string>;

const ResourceCalendarEntryView = ({
  entry,
  onSelectEntry,
  placement,
}: {
  entry: ResourceCalendarEntry;
  onSelectEntry: ResourceCalendarProps["onSelectEntry"];
  placement: { columnStart: number; span: number };
}) => {
  const className = cn(
    "z-10 m-2 px-3 py-2 font-medium shadow-sm",
    RESOURCE_CALENDAR_ENTRY_TONES[entry.tone ?? "accent"],
  );
  const style = {
    gridColumn: `${String(placement.columnStart)} / span ${String(placement.span)}`,
    gridRow: 1,
  } satisfies CSSProperties;
  const content = (
    <>
      <span className="block truncate">{entry.label}</span>
      {entry.meta === undefined ? null : (
        <span className="block truncate opacity-75">{entry.meta}</span>
      )}
    </>
  );

  if (onSelectEntry === undefined) {
    return (
      <CalendarEntrySurface
        aria-label={entry.accessibleLabel}
        className={className}
        style={style}
      >
        {content}
      </CalendarEntrySurface>
    );
  }

  return (
    <CalendarEntryButton
      aria-label={entry.accessibleLabel}
      className={className}
      onClick={() => onSelectEntry(entry)}
      style={style}
    >
      {content}
    </CalendarEntryButton>
  );
};

const assertUniqueIds = (ids: readonly string[], label: string): void => {
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`${label} ids must be unique`);
  }
};

const assertResourceCalendarContract = ({
  columns,
  entries,
  resources,
}: Pick<ResourceCalendarProps, "columns" | "entries" | "resources">): void => {
  assertConsecutiveCalendarDates(columns.map(({ date }) => date));
  assertUniqueIds(
    resources.map(({ id }) => id),
    "Resource calendar resource",
  );
  assertUniqueIds(
    entries.map(({ id }) => id),
    "Resource calendar entry",
  );
  const resourceIds = new Set(resources.map(({ id }) => id));
  const orphan = entries.find(({ resourceId }) => !resourceIds.has(resourceId));
  if (orphan !== undefined) {
    throw new TypeError(
      `Resource calendar entry ${orphan.id} references an unknown resource`,
    );
  }
};

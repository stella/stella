import { useId } from "react";
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
  layoutResourceCalendarEntries,
  nextCalendarDate,
} from "./resource-calendar.logic";
import type { ResourceCalendarLanePlacement } from "./resource-calendar.logic";

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

type PlacedResourceCalendarEntry = {
  entry: ResourceCalendarEntry;
  placement: ResourceCalendarLanePlacement;
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
  const calendarId = useId();

  if (resources.length === 0) {
    return <div data-slot="resource-calendar-empty">{empty}</div>;
  }

  const gridStyle = {
    gridTemplateColumns: `14rem repeat(${String(columns.length)}, minmax(7rem, 1fr))`,
  } satisfies CSSProperties;
  const calendarWidthStyle = {
    minWidth: `${String(14 + columns.length * 7)}rem`,
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
  const getColumnHeaderId = (index: number) =>
    `${calendarId}-column-${String(index)}`;

  return (
    <section
      aria-colcount={columns.length + 1}
      aria-label={ariaLabel}
      aria-rowcount={resources.length + 1}
      className="border-border bg-card overflow-x-auto rounded-xl border"
      data-slot="resource-calendar"
      role="table"
    >
      <div className="w-full" style={calendarWidthStyle}>
        <CalendarHeaderRow role="row" style={gridStyle}>
          <CalendarHeaderCell
            aria-colindex={1}
            className="bg-card sticky start-0 z-30 text-start font-semibold tracking-wide uppercase"
            role="columnheader"
          >
            {resourceHeader}
          </CalendarHeaderCell>
          {columns.map((column, index) => (
            <CalendarHeaderCell
              aria-colindex={index + 2}
              id={getColumnHeaderId(index)}
              key={column.date}
              role="columnheader"
            >
              <span className="block">{column.label}</span>
              {column.meta === undefined ? null : (
                <span className="text-foreground mt-0.5 block font-semibold">
                  {column.meta}
                </span>
              )}
            </CalendarHeaderCell>
          ))}
        </CalendarHeaderRow>

        {resources.map((resource, resourceIndex) => {
          const resourceEntries = entriesByResource.get(resource.id) ?? [];
          const layout = layoutResourceCalendarEntries(
            resourceEntries,
            visibleRange,
          );
          const resourceEntryById = new Map(
            resourceEntries.map((entry) => [entry.id, entry]),
          );
          const visibleEntriesByColumn = new Map<
            number,
            PlacedResourceCalendarEntry[]
          >();
          for (const placement of layout.placements) {
            const entry = resourceEntryById.get(placement.entryId);
            if (entry === undefined) {
              throw new TypeError(
                `Resource calendar layout references unknown entry ${placement.entryId}`,
              );
            }
            const existing = visibleEntriesByColumn.get(placement.columnStart);
            if (existing === undefined) {
              visibleEntriesByColumn.set(placement.columnStart, [
                { entry, placement },
              ]);
              continue;
            }
            existing.push({ entry, placement });
          }
          const resourceHeaderId = `${calendarId}-resource-${String(resourceIndex)}`;
          const resourceRowStyle = {
            ...gridStyle,
            minHeight: `${String(Math.max(5, layout.rowCount * 3.75))}rem`,
          } satisfies CSSProperties;

          return (
            <div
              className="border-border relative grid min-h-20 border-b last:border-b-0"
              data-slot="resource-calendar-row"
              key={resource.id}
              role="row"
              style={resourceRowStyle}
            >
              <CalendarCell
                aria-colindex={1}
                aria-rowindex={resourceIndex + 2}
                className="bg-card sticky start-0 z-20 border-b-0 px-4 py-3"
                id={resourceHeaderId}
                role="rowheader"
              >
                <span className="block truncate text-sm font-semibold">
                  {resource.label}
                </span>
                {resource.meta === undefined ? null : (
                  <span className="text-muted-foreground mt-1 block truncate text-xs">
                    {resource.meta}
                  </span>
                )}
              </CalendarCell>
              {columns.map((column, columnIndex) => {
                const columnStart = columnIndex + 2;
                const visibleEntries =
                  visibleEntriesByColumn.get(columnStart) ?? [];

                return (
                  <CalendarCell
                    aria-colindex={columnStart}
                    aria-labelledby={`${resourceHeaderId} ${getColumnHeaderId(columnIndex)}`}
                    aria-rowindex={resourceIndex + 2}
                    className="bg-background/40 relative border-b-0 last:border-e-0"
                    key={column.date}
                    role="gridcell"
                  >
                    {visibleEntries.map(({ entry, placement }) => {
                      const labelledBy = [
                        resourceHeaderId,
                        ...Array.from({ length: placement.span }, (_, index) =>
                          getColumnHeaderId(columnIndex + index),
                        ),
                      ].join(" ");

                      return (
                        <ResourceCalendarEntryView
                          entry={entry}
                          key={entry.id}
                          labelledBy={labelledBy}
                          onSelectEntry={onSelectEntry}
                          placement={placement}
                          rowCount={layout.rowCount}
                        />
                      );
                    })}
                  </CalendarCell>
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
  destructive: "border-destructive/32 bg-destructive/12 text-foreground border",
  neutral: "border-border bg-muted text-foreground border",
  warning: "border-warning/30 bg-warning/15 text-foreground border",
} as const satisfies Record<ResourceCalendarEntryTone, string>;

const ResourceCalendarEntryView = ({
  entry,
  labelledBy,
  onSelectEntry,
  placement,
  rowCount,
}: {
  entry: ResourceCalendarEntry;
  labelledBy: string;
  onSelectEntry: ResourceCalendarProps["onSelectEntry"];
  placement: ResourceCalendarLanePlacement;
  rowCount: number;
}) => {
  const className = cn(
    "h-full w-full px-3 py-2 font-medium shadow-sm",
    RESOURCE_CALENDAR_ENTRY_TONES[entry.tone ?? "accent"],
  );
  const style = {
    blockSize: `${String(100 / rowCount)}%`,
    insetBlockStart: `${String(((placement.rowStart - 1) * 100) / rowCount)}%`,
    insetInlineStart: 0,
    inlineSize: `calc(${String(placement.span)} * 100%)`,
  } satisfies CSSProperties;
  const content = (
    <>
      <span className="block truncate">{entry.label}</span>
      {entry.meta === undefined ? null : (
        <span className="block truncate opacity-75">{entry.meta}</span>
      )}
    </>
  );

  return (
    <div className="absolute z-10 min-w-0 p-2" style={style}>
      {onSelectEntry === undefined ? (
        <CalendarEntrySurface
          aria-describedby={labelledBy}
          aria-label={entry.accessibleLabel}
          className={className}
        >
          {content}
        </CalendarEntrySurface>
      ) : (
        <CalendarEntryButton
          aria-describedby={labelledBy}
          aria-label={entry.accessibleLabel}
          className={className}
          onClick={() => onSelectEntry(entry)}
        >
          {content}
        </CalendarEntryButton>
      )}
    </div>
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

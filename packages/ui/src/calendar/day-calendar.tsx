import { useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent,
  PointerEvent,
  ReactElement,
  ReactNode,
} from "react";

import { panic } from "better-result";

import { resolveMatterColor } from "../lib/matter-colors";
import { cn } from "../lib/utils";
import {
  boundsHeight,
  DAY_CALENDAR_SLOT_HEIGHT_PX,
  extendRange,
  getDayBounds,
  getHourTicks,
  layoutOverlaps,
  moveRange,
  offsetToTime,
  rangeFromDrag,
  slotAt,
  timeToOffset,
} from "./day-calendar.logic";
import type {
  DayCalendarGranularity,
  DayCalendarLanePlacement,
  DayCalendarRange,
} from "./day-calendar.logic";

/** A block paints in its matter's colour, or in the neutral surface tone. */
export type DayCalendarTone =
  | { color: string | null; matterId: string; type: "matter" }
  | { type: "neutral" };

/** Whether an entry is still provisional (drawn dashed) or final. */
export type DayCalendarEntryState = "draft" | "final";

type DayCalendarBlockFields = DayCalendarRange & {
  accessibleLabel: string;
  detail?: ReactNode;
  id: string;
  title: ReactNode;
  tone: DayCalendarTone;
};

export type DayCalendarBlock =
  | (DayCalendarBlockFields & { kind: "entry"; state: DayCalendarEntryState })
  | (DayCalendarBlockFields & { kind: "mixed" })
  | (DayCalendarBlockFields & { kind: "segment" });

export type DayCalendarRangeSelection =
  { label: string; type: "enabled" } | { type: "disabled" };

type DayCalendarColumnHeader = {
  badge?: ReactNode;
  id: string;
  label: ReactNode;
};

/**
 * A `locked` column has no blocks field, so caller data cannot reach it: it
 * paints synthetic placeholder bars behind the caller's `action`.
 */
export type DayCalendarColumn =
  | (DayCalendarColumnHeader & {
      blocks: readonly DayCalendarBlock[];
      rangeSelection: DayCalendarRangeSelection;
      type: "blocks";
    })
  | (DayCalendarColumnHeader & { action: ReactNode; type: "locked" });

/**
 * The committed range the caller is acting on. `panel` anchors caller content
 * (an entry form) at the range's start, in the column it names.
 */
export type DayCalendarSelection = {
  columnId: string;
  panel?: { columnId: string; content: ReactNode };
  range: DayCalendarRange;
};

type DayCalendarProps = {
  ariaLabel: string;
  columns: readonly DayCalendarColumn[];
  /** The calendar day, `YYYY-MM-DD`, in `timeZone`. */
  date: string;
  granularity: DayCalendarGranularity;
  /** Whole wall-clock hours the view covers, `0 <= startHour < endHour <= 24`. */
  hours: { endHour: number; startHour: number };
  /** The reader's formatting locale; it decides 12- or 24-hour labels. */
  locale: string;
  /** The current instant; the now-line shows only while it falls inside the day. */
  nowMs: number;
  onSelectRange: (columnId: string, range: DayCalendarRange) => void;
  selection: DayCalendarSelection | null;
  timeZone: string;
};

type DraftSelection = {
  columnId: string;
  range: DayCalendarRange;
} & (
  | { anchorMs: number; pointerId: number; type: "pointer" }
  | { type: "keyboard" }
);

const GUTTER_WIDTH = "4rem";

export const DayCalendar = ({
  ariaLabel,
  columns,
  date,
  granularity,
  hours,
  locale,
  nowMs,
  onSelectRange,
  selection,
  timeZone,
}: DayCalendarProps): ReactElement => {
  assertDayCalendarContract(columns);
  const [draft, setDraft] = useState<DraftSelection | null>(null);

  const bounds = getDayBounds({ date, ...hours, timeZone });
  const grid = { granularity, bounds };
  const height = boundsHeight(grid);
  const formatTime = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  const formatRange = (range: DayCalendarRange) =>
    formatTime.formatRange(range.startMs, range.endMs);
  const minutesFromStart = (ms: number) =>
    Math.round((ms - bounds.startMs) / 60_000);
  const nowVisible = nowMs >= bounds.startMs && nowMs < bounds.endMs;

  const timeAt = (event: PointerEvent<HTMLElement>) =>
    offsetToTime(
      event.clientY - event.currentTarget.getBoundingClientRect().top,
      grid,
    );

  const handlePointerDown = (
    columnId: string,
    event: PointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const anchorMs = timeAt(event);
    setDraft({
      anchorMs,
      columnId,
      pointerId: event.pointerId,
      range: rangeFromDrag({ anchorMs, pointerMs: anchorMs }, grid),
      type: "pointer",
    });
  };

  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    if (draft?.type !== "pointer" || draft.pointerId !== event.pointerId) {
      return;
    }
    setDraft({
      anchorMs: draft.anchorMs,
      columnId: draft.columnId,
      pointerId: draft.pointerId,
      range: rangeFromDrag(
        { anchorMs: draft.anchorMs, pointerMs: timeAt(event) },
        grid,
      ),
      type: "pointer",
    });
  };

  const handlePointerUp = (event: PointerEvent<HTMLElement>) => {
    if (draft?.type !== "pointer" || draft.pointerId !== event.pointerId) {
      return;
    }
    const range = rangeFromDrag(
      { anchorMs: draft.anchorMs, pointerMs: timeAt(event) },
      grid,
    );
    setDraft(null);
    onSelectRange(draft.columnId, range);
  };

  const handlePointerCancel = (event: PointerEvent<HTMLElement>) => {
    if (draft?.type === "pointer" && draft.pointerId === event.pointerId) {
      setDraft(null);
    }
  };

  const initialKeyboardRange = (columnId: string): DayCalendarRange => {
    if (selection?.columnId === columnId) {
      return selection.range;
    }
    return slotAt(nowVisible ? nowMs : bounds.startMs, grid);
  };

  const handleKeyDown = (
    columnId: string,
    event: KeyboardEvent<HTMLElement>,
  ) => {
    const current = draft?.columnId === columnId ? draft : null;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        const slots = event.key === "ArrowDown" ? 1 : -1;
        if (current === null) {
          setDraft({
            columnId,
            range: initialKeyboardRange(columnId),
            type: "keyboard",
          });
          return;
        }
        setDraft({
          columnId,
          range: event.shiftKey
            ? extendRange(current.range, slots, grid)
            : moveRange(current.range, slots, grid),
          type: "keyboard",
        });
        return;
      }
      case "Enter": {
        if (current === null) {
          return;
        }
        event.preventDefault();
        setDraft(null);
        onSelectRange(columnId, current.range);
        return;
      }
      case "Escape": {
        if (current === null) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setDraft(null);
        return;
      }
      default:
    }
  };

  const gridStyle = {
    gridTemplateColumns: `${GUTTER_WIDTH} repeat(${String(columns.length)}, minmax(0, 1fr))`,
  } satisfies CSSProperties;
  const bodyStyle = { blockSize: height } satisfies CSSProperties;
  const slotHeight = DAY_CALENDAR_SLOT_HEIGHT_PX[granularity];
  // Hour lines over lighter slot lines; an hour is 60 real minutes, which
  // matches the hour labels on a daylight-saving day as well.
  const slotLinesStyle = {
    backgroundImage: [
      "linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
      "linear-gradient(to bottom, color-mix(in srgb, var(--border) 45%, transparent) 1px, transparent 1px)",
    ].join(", "),
    backgroundSize: `100% ${String((slotHeight * 60) / granularity)}px, 100% ${String(slotHeight)}px`,
  } satisfies CSSProperties;
  const hourTicks = getHourTicks(bounds);

  return (
    <section
      aria-label={ariaLabel}
      className="bg-card border-border grid rounded-xl border"
      data-granularity={granularity}
      data-slot="day-calendar"
      style={gridStyle}
    >
      <div
        aria-hidden="true"
        className="bg-card border-border sticky top-0 z-30 rounded-ss-xl border-b"
      />
      {columns.map((column, index) => (
        <header
          className={cn(
            "bg-card border-border text-muted-foreground sticky top-0 z-30 flex min-w-0 items-center gap-2 border-s border-b px-3 py-2.5 text-xs font-medium",
            index === columns.length - 1 && "rounded-se-xl",
          )}
          data-slot="day-calendar-column-header"
          key={column.id}
        >
          <span className="min-w-0 shrink-0 truncate">{column.label}</span>
          {column.badge === undefined ? null : (
            <span className="bg-muted text-muted-foreground text-2xs min-w-0 truncate rounded-full px-2 py-0.5">
              {column.badge}
            </span>
          )}
        </header>
      ))}

      <div
        aria-hidden="true"
        className="text-muted-foreground text-2xs relative tabular-nums"
        style={bodyStyle}
      >
        {hourTicks.map((tick) => (
          <span
            className="absolute end-2 pt-0.5"
            data-slot="day-calendar-hour"
            key={tick}
            style={{ insetBlockStart: timeToOffset(tick, grid) }}
          >
            {formatTime.format(tick)}
          </span>
        ))}
      </div>

      {columns.map((column) => {
        const columnSelection =
          selection?.columnId === column.id ? selection.range : null;
        const columnDraft = draft?.columnId === column.id ? draft.range : null;
        const panel =
          selection?.panel?.columnId === column.id
            ? { content: selection.panel.content, range: selection.range }
            : null;

        return (
          <div
            className="border-border relative min-w-0 border-s"
            data-column-id={column.id}
            data-slot="day-calendar-column"
            data-type={column.type}
            key={column.id}
            style={bodyStyle}
          >
            {column.type === "locked" ? (
              <LockedColumnBody action={column.action} />
            ) : null}
            {column.type === "blocks" &&
            column.rangeSelection.type === "enabled" ? (
              <div
                aria-keyshortcuts="ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown Enter Escape"
                aria-label={column.rangeSelection.label}
                aria-orientation="vertical"
                aria-valuemax={minutesFromStart(bounds.endMs)}
                aria-valuemin={0}
                aria-valuenow={minutesFromStart(
                  (columnDraft ?? initialKeyboardRange(column.id)).startMs,
                )}
                aria-valuetext={formatRange(
                  columnDraft ?? initialKeyboardRange(column.id),
                )}
                className="focus-visible:ring-ring absolute inset-0 touch-none outline-none select-none focus-visible:ring-2 focus-visible:ring-inset"
                data-slot="day-calendar-surface"
                onKeyDown={(event) => handleKeyDown(column.id, event)}
                onPointerCancel={handlePointerCancel}
                onPointerDown={(event) => handlePointerDown(column.id, event)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                role="slider"
                style={slotLinesStyle}
                tabIndex={0}
              >
                <ColumnBlocks blocks={column.blocks} grid={grid} />
                <RangeOutline
                  committed={columnSelection}
                  draft={columnDraft}
                  formatTime={formatTime}
                  grid={grid}
                />
              </div>
            ) : null}
            {column.type === "blocks" &&
            column.rangeSelection.type === "disabled" ? (
              <div
                className="absolute inset-0"
                data-slot="day-calendar-surface"
                style={slotLinesStyle}
              >
                <ColumnBlocks blocks={column.blocks} grid={grid} />
                <RangeOutline
                  committed={columnSelection}
                  draft={null}
                  formatTime={formatTime}
                  grid={grid}
                />
              </div>
            ) : null}
            {nowVisible && column.type === "blocks" ? (
              <div
                aria-hidden="true"
                className="bg-destructive pointer-events-none absolute inset-x-0 z-20 h-0.5"
                data-slot="day-calendar-now"
                style={{ insetBlockStart: timeToOffset(nowMs, grid) }}
              />
            ) : null}
            {panel === null ? null : (
              <div
                className="absolute inset-x-2 z-40"
                data-slot="day-calendar-panel"
                style={{
                  insetBlockStart: timeToOffset(panel.range.startMs, grid),
                }}
              >
                {panel.content}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
};

type GridOptions = {
  granularity: DayCalendarGranularity;
  bounds: DayCalendarRange;
};

const ColumnBlocks = ({
  blocks,
  grid,
}: {
  blocks: readonly DayCalendarBlock[];
  grid: GridOptions;
}) => {
  const visible = blocks.flatMap((block) => {
    const startMs = Math.max(block.startMs, grid.bounds.startMs);
    const endMs = Math.min(block.endMs, grid.bounds.endMs);
    return endMs > startMs ? [{ block, endMs, id: block.id, startMs }] : [];
  });
  const lanes = layoutOverlaps(visible);

  return visible.map(({ block, endMs, startMs }) => {
    const lane = lanes.get(block.id);
    if (lane === undefined) {
      panic(`Day calendar layout lost block ${block.id}`);
    }
    return (
      <DayCalendarBlockView
        block={block}
        key={block.id}
        lane={lane}
        range={{ endMs, startMs }}
        grid={grid}
      />
    );
  });
};

/** Below this height a block puts its title and detail on one line. */
const TWO_LINE_BLOCK_MIN_PX = 40;

const BLOCK_KIND_CLASSES = {
  entry: "font-medium",
  mixed: "text-muted-foreground",
  segment: "",
} as const satisfies Record<DayCalendarBlock["kind"], string>;

const ENTRY_STATE_CLASSES = {
  draft: "border border-dashed border-current/40",
  final: "",
} as const satisfies Record<DayCalendarEntryState, string>;

const DayCalendarBlockView = ({
  block,
  grid,
  lane,
  range,
}: {
  block: DayCalendarBlock;
  grid: GridOptions;
  lane: DayCalendarLanePlacement;
  range: DayCalendarRange;
}) => {
  const top = timeToOffset(range.startMs, grid);
  const blockSize = Math.max(timeToOffset(range.endMs, grid) - top, 6);
  const placement = {
    blockSize,
    inlineSize: `${String(100 / lane.laneCount)}%`,
    insetBlockStart: top,
    insetInlineStart: `${String((lane.lane * 100) / lane.laneCount)}%`,
  } satisfies CSSProperties;

  return (
    <div
      className="pointer-events-none absolute px-1.5 py-px"
      style={placement}
    >
      <article
        aria-label={block.accessibleLabel}
        className={cn(
          "text-foreground flex h-full min-w-0 overflow-hidden rounded-md px-2.5 text-start text-xs",
          blockSize < TWO_LINE_BLOCK_MIN_PX
            ? "flex-row items-center gap-2"
            : "flex-col gap-0.5 py-1",
          BLOCK_KIND_CLASSES[block.kind],
          block.kind === "entry" && ENTRY_STATE_CLASSES[block.state],
          block.tone.type === "matter" && "border-s-[3px]",
          block.tone.type === "neutral" && "bg-muted",
        )}
        data-kind={block.kind}
        data-slot="day-calendar-block"
        style={blockSurfaceStyle(block)}
      >
        <span className="min-w-0 shrink-0 truncate font-medium">
          {block.title}
        </span>
        {block.detail === undefined ? null : (
          <span className="text-muted-foreground min-w-0 truncate tabular-nums">
            {block.detail}
          </span>
        )}
      </article>
    </div>
  );
};

const MIXED_STRIPES =
  "repeating-linear-gradient(135deg, var(--muted) 0 6px, transparent 6px 12px)";

function blockSurfaceStyle(block: DayCalendarBlock): CSSProperties {
  const tone = block.tone;
  const stripes = block.kind === "mixed" ? MIXED_STRIPES : undefined;
  switch (tone.type) {
    case "neutral": {
      return { backgroundImage: stripes };
    }
    case "matter": {
      const color = resolveMatterColor(tone.matterId, tone.color);
      return {
        backgroundColor: `color-mix(in srgb, ${color} 16%, var(--card))`,
        backgroundImage: stripes,
        borderInlineStartColor: color,
      };
    }
    default: {
      tone satisfies never;
      return panic("Unhandled day calendar tone");
    }
  }
}

const RangeOutline = ({
  committed,
  draft,
  formatTime,
  grid,
}: {
  committed: DayCalendarRange | null;
  draft: DayCalendarRange | null;
  formatTime: Intl.DateTimeFormat;
  grid: GridOptions;
}) => {
  const range = draft ?? committed;
  if (range === null) {
    return null;
  }
  const top = timeToOffset(range.startMs, grid);

  return (
    <div
      className="border-info bg-info/10 pointer-events-none absolute inset-x-1 z-10 rounded-lg border-2"
      data-slot="day-calendar-selection"
      data-state={draft === null ? "committed" : "draft"}
      style={{
        blockSize: timeToOffset(range.endMs, grid) - top,
        insetBlockStart: top,
      }}
    >
      <span className="text-info-foreground text-2xs absolute end-1 bottom-full mb-0.5 tabular-nums">
        {formatTime.format(range.startMs)}
      </span>
      <span className="text-info-foreground text-2xs absolute end-1 top-full mt-0.5 tabular-nums">
        {formatTime.format(range.endMs)}
      </span>
    </div>
  );
};

/**
 * Placeholder geometry for a locked column, as fractions of the column. It is
 * fixed so that nothing about the hidden data (count, timing, length) leaks.
 */
const LOCKED_PLACEHOLDER_BARS = [
  { blockSize: "7%", inlineEnd: "30%", start: "1%", tone: "tinted" },
  { blockSize: "5%", inlineEnd: "12%", start: "9%", tone: "neutral" },
  { blockSize: "5%", inlineEnd: "40%", start: "15%", tone: "neutral" },
  { blockSize: "8%", inlineEnd: "18%", start: "21%", tone: "tinted" },
  { blockSize: "7%", inlineEnd: "25%", start: "30%", tone: "neutral" },
  { blockSize: "8%", inlineEnd: "35%", start: "42%", tone: "tinted" },
  { blockSize: "6%", inlineEnd: "22%", start: "55%", tone: "neutral" },
] as const;

const LOCKED_BAR_TONES = {
  neutral: "bg-muted-foreground/15",
  tinted: "bg-muted-foreground/25",
} as const satisfies Record<
  (typeof LOCKED_PLACEHOLDER_BARS)[number]["tone"],
  string
>;

const LockedColumnBody = ({ action }: { action: ReactNode }) => (
  <div className="absolute inset-0 overflow-hidden">
    <div
      aria-hidden="true"
      className="absolute inset-0 opacity-70 blur-sm"
      data-slot="day-calendar-locked-placeholder"
      inert
    >
      {LOCKED_PLACEHOLDER_BARS.map((bar) => (
        <div
          className={cn(
            "absolute start-2.5 rounded-lg",
            LOCKED_BAR_TONES[bar.tone],
          )}
          key={bar.start}
          style={{
            blockSize: bar.blockSize,
            insetBlockStart: bar.start,
            insetInlineEnd: bar.inlineEnd,
          }}
        />
      ))}
    </div>
    <div
      className="absolute inset-x-3 top-16 flex justify-center"
      data-slot="day-calendar-locked-action"
    >
      {action}
    </div>
  </div>
);

function assertDayCalendarContract(
  columns: readonly DayCalendarColumn[],
): void {
  const ids = new Set(columns.map(({ id }) => id));
  if (ids.size !== columns.length) {
    panic("Day calendar column ids must be unique");
  }
}

import {
  CalendarCell,
  CalendarHeaderCell,
  CalendarHeaderRow,
} from "@stll/ui/calendar-primitives";
import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronLeftIcon, ChevronRightIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import type { WorkspaceView } from "@/lib/types";

/** The calendar's page: the header row over the grid, filling the body. */
export const CALENDAR_VIEW_CLASS = "flex h-full min-w-0 flex-col";

/** The header row: today, previous, next and the period's label. */
export const CALENDAR_HEADER_ROW_CLASS =
  "flex min-w-0 items-center gap-2 px-4 py-2";

/** The month view's scroll area under the weekday row. */
export const CALENDAR_MONTH_SCROLL_CLASS =
  "relative flex-1 overflow-y-auto overscroll-contain";

/** The month view's pinned month label over the weeks. */
export const CALENDAR_MONTH_LABEL_ROW_CLASS =
  "bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-20 border-b px-4 py-1.5 backdrop-blur";

/** One week of the month view: a sixth of the screen under the label row. */
export const CALENDAR_MONTH_WEEK_CLASS =
  "grid min-h-[calc((100%_-_1.75rem)/6)] grid-cols-7";

/** The week view's one row of days. */
export const CALENDAR_WEEK_ROW_CLASS = "grid flex-1 grid-cols-7 grid-rows-1";

/** A day's box as the live day draws it (calendar-day-cell.tsx), before what marks it. */
const CALENDAR_DAY_CELL_CLASS =
  "group/day relative flex flex-col gap-0.5 overflow-hidden p-1";

/** A week view's day: tall enough to hold a day's entries. */
const CALENDAR_WEEK_DAY_CELL_CLASS = "min-h-[300px]";

/** Fixed positions in a placeholder grid that never reorders. */
const slots = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, slot) => `${prefix}-${String(slot)}`);

const WEEKDAYS = slots("day", 7);
const MONTH_WEEKS = slots("week", 6);

/** A day while the calendar loads: its box, and a bar where its number goes. */
const CalendarDayCellPending = ({ week }: { week: boolean }) => (
  <CalendarCell
    className={cn(
      CALENDAR_DAY_CELL_CLASS,
      week && CALENDAR_WEEK_DAY_CELL_CLASS,
    )}
  >
    <div className="flex items-center justify-between">
      <span className="inline-flex size-6 items-center justify-center">
        <FaceLabelPending className="w-3" />
      </span>
    </div>
  </CalendarCell>
);

/** The weekday row while the reader's week (its first day, its names) loads. */
const CalendarWeekHeaderPending = () => (
  <CalendarHeaderRow className="grid-cols-7">
    {WEEKDAYS.map((day) => (
      <CalendarHeaderCell className="border-e-0 py-1" key={day}>
        <FaceLabelPending className="w-6" />
      </CalendarHeaderCell>
    ))}
  </CalendarHeaderRow>
);

/**
 * A calendar view before it mounts: the header row with its controls'
 * faces, the weekday row and the grid of the view's mode (a month's weeks,
 * or one week), with bars where the dates go. A year view, and a view with
 * no date to show by, has no grid of days to claim.
 */
export const CalendarViewPending = ({
  view,
}: {
  view: WorkspaceView<"calendar">;
}) => {
  const { datePropertyId, mode } = view.layout;
  if (!datePropertyId || mode === "year") {
    return null;
  }
  return (
    <div aria-hidden="true" className={CALENDAR_VIEW_CLASS}>
      <div className={CALENDAR_HEADER_ROW_CLASS}>
        <ButtonFace size="sm" variant="outline">
          <PendingText barClassName="w-10" id="common.today" />
        </ButtonFace>
        <ButtonFace size="icon-sm" variant="ghost">
          <DirectionalIcon icon={ChevronLeftIcon} />
        </ButtonFace>
        <ButtonFace size="icon-sm" variant="ghost">
          <DirectionalIcon icon={ChevronRightIcon} />
        </ButtonFace>
        <span className="text-sm font-medium">
          <FaceLabelPending className="w-28" />
        </span>
      </div>
      <CalendarWeekHeaderPending />
      {mode === "week" ? (
        <div className={CALENDAR_WEEK_ROW_CLASS}>
          {WEEKDAYS.map((day) => (
            <CalendarDayCellPending key={day} week />
          ))}
        </div>
      ) : (
        <div className={CALENDAR_MONTH_SCROLL_CLASS}>
          <div className={CALENDAR_MONTH_LABEL_ROW_CLASS}>
            <span className="text-xs font-medium">
              <FaceLabelPending className="w-20" />
            </span>
          </div>
          {MONTH_WEEKS.map((week) => (
            <div className={CALENDAR_MONTH_WEEK_CLASS} key={week}>
              {WEEKDAYS.map((day) => (
                <CalendarDayCellPending key={day} week={false} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

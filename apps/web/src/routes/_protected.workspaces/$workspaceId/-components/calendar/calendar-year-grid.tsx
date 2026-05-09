import { cn } from "@stll/ui/lib/utils";
import { useLocale } from "use-intl";

import type { CalendarDay } from "./calendar-utils";
import {
  appendToMapArray,
  getMonthDays,
  getMonthLabels,
  getWeekdayLabels,
} from "./calendar-utils";

/**
 * Entity dot descriptor for the year grid.
 * Each dot is a colored circle on a given date.
 */
export type YearDot = {
  date: string;
  color: string;
};

type CalendarYearGridProps = {
  year: number;
  dots: YearDot[];
  onMonthClick: (month: number) => void;
};

/**
 * Year view: 4×3 grid of compact mini month calendars.
 * Days with entities show colored dots beneath the number.
 */
export const CalendarYearGrid = ({
  year,
  dots,
  onMonthClick,
}: CalendarYearGridProps) => {
  const locale = useLocale();

  const monthLabels = getMonthLabels(locale, year, "long");

  const weekdayLabels = getWeekdayLabels(locale, "narrow");

  // Index dots by date for O(1) lookup
  const dotsByDate = new Map<string, YearDot[]>();
  for (const dot of dots) {
    appendToMapArray(dotsByDate, dot.date, dot);
  }

  const now = new Date();
  const currentMonth = now.getUTCFullYear() === year ? now.getUTCMonth() : -1;

  return (
    <div className="flex flex-1 items-start justify-center overflow-y-auto p-6">
      <div className="grid w-full max-w-5xl grid-cols-4 gap-x-6 gap-y-4">
        {Array.from({ length: 12 }, (_, monthIdx) => (
          <MiniMonth
            dotsByDate={dotsByDate}
            isCurrent={monthIdx === currentMonth}
            key={monthLabels[monthIdx] ?? monthIdx}
            label={monthLabels[monthIdx] ?? ""}
            month={monthIdx}
            onClick={() => onMonthClick(monthIdx)}
            weekdayLabels={weekdayLabels}
            year={year}
          />
        ))}
      </div>
    </div>
  );
};

// -- Mini month --

type MiniMonthProps = {
  year: number;
  month: number;
  label: string;
  isCurrent: boolean;
  weekdayLabels: string[];
  dotsByDate: Map<string, YearDot[]>;
  onClick: () => void;
};

const MiniMonth = ({
  year,
  month,
  label,
  isCurrent,
  weekdayLabels,
  dotsByDate,
  onClick,
}: MiniMonthProps) => {
  const days = getMonthDays(year, month);

  return (
    <button
      className={cn(
        "flex flex-col rounded-lg px-2 pt-1.5 pb-2",
        "hover:bg-accent/40 text-start transition-colors",
      )}
      onClick={onClick}
      type="button"
    >
      <span
        className={cn(
          "mb-1.5 text-[13px] font-semibold",
          isCurrent && "text-primary",
        )}
      >
        {label}
      </span>

      {/* Weekday headers */}
      <div className="mb-0.5 grid grid-cols-7 gap-px">
        {weekdayLabels.map((wd, i) => (
          <span
            className={cn(
              "text-center text-[10px] leading-4",
              "text-foreground-muted",
              i >= 5 && "text-foreground-disabled",
            )}
            key={wd}
          >
            {wd}
          </span>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-px">
        {days.map((day) => (
          <MiniDay day={day} dots={dotsByDate.get(day.date)} key={day.date} />
        ))}
      </div>
    </button>
  );
};

// -- Mini day cell --

const MAX_DOTS = 3;

const MiniDay = ({
  day,
  dots,
}: {
  day: CalendarDay;
  dots: YearDot[] | undefined;
}) => {
  const dayNum = Number.parseInt(day.date.slice(8), 10);

  if (!day.isCurrentMonth) {
    return <span className="aspect-square" />;
  }

  const hasDots = dots && dots.length > 0;

  return (
    <span
      className={cn(
        "relative flex aspect-square items-center justify-center",
        "text-[11px] leading-none",
        day.isToday &&
          "bg-primary text-primary-foreground rounded-full font-bold",
        day.isWeekend && !day.isToday && "text-foreground-muted",
      )}
    >
      {dayNum}
      {hasDots && (
        <span className="absolute bottom-0 flex gap-px">
          {dots.slice(0, MAX_DOTS).map((dot, i) => (
            <span
              className="size-[3px] rounded-full"
              key={`${dot.color}-${i}`}
              style={{ backgroundColor: dot.color }}
            />
          ))}
        </span>
      )}
    </span>
  );
};

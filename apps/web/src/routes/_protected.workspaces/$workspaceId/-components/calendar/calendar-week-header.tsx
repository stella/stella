import { CalendarHeaderCell, CalendarHeaderRow } from "@stll/ui/calendar";
import { cn } from "@stll/ui/utils";

type CalendarWeekHeaderProps = {
  weekdayLabels: string[];
  firstWeekday: number;
  weekend: ReadonlySet<number>;
};

export const CalendarWeekHeader = ({
  weekdayLabels,
  firstWeekday,
  weekend,
}: CalendarWeekHeaderProps) => (
  <CalendarHeaderRow className="grid-cols-7">
    {weekdayLabels.map((label, i) => {
      const dayOfWeek = (firstWeekday + i) % 7;
      const isWeekend = weekend.has(dayOfWeek);
      return (
        <CalendarHeaderCell
          className={cn("border-e-0 py-1", isWeekend && "bg-muted/20")}
          key={label}
        >
          {label}
        </CalendarHeaderCell>
      );
    })}
  </CalendarHeaderRow>
);

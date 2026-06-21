import { cn } from "@stll/ui/lib/utils";

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
  <div className="grid grid-cols-7 border-b">
    {weekdayLabels.map((label, i) => {
      const dayOfWeek = (firstWeekday + i) % 7;
      const isWeekend = weekend.has(dayOfWeek);
      return (
        <div
          className={cn(
            "px-2 py-1 text-center text-xs font-medium",
            "text-muted-foreground",
            isWeekend && "bg-muted/20",
          )}
          key={label}
        >
          {label}
        </div>
      );
    })}
  </div>
);

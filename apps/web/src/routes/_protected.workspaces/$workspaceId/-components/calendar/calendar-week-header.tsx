import { cn } from "@stll/ui/lib/utils";

type CalendarWeekHeaderProps = {
  weekdayLabels: string[];
};

export const CalendarWeekHeader = ({
  weekdayLabels,
}: CalendarWeekHeaderProps) => (
  <div className="grid grid-cols-7 border-b">
    {weekdayLabels.map((label, i) => (
      <div
        className={cn(
          "px-2 py-1 text-center text-xs font-medium",
          "text-muted-foreground",
          i >= 5 && "bg-muted/20",
        )}
        key={label}
      >
        {label}
      </div>
    ))}
  </div>
);

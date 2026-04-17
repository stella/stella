import { useEffect, useState } from "react";

/**
 * Red horizontal line showing the current time of day.
 * Used in week-view day cells to indicate "now".
 * Updates every minute.
 */
export const CurrentTimeIndicator = () => {
  const [top, setTop] = useState<number | null>(null);

  useEffect(() => {
    const update = () => {
      const now = new Date();
      const minutesSinceMidnight = now.getHours() * 60 + now.getMinutes();
      const pct = (minutesSinceMidnight / 1440) * 100;
      setTop(pct);
    };
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, []);

  if (top === null) {
    return null;
  }

  return (
    <div
      className="pointer-events-none absolute start-0 end-0 z-10 flex items-center"
      style={{ top: `${top}%` }}
    >
      <div className="bg-destructive size-1.5 rounded-full" />
      <div className="bg-destructive h-px flex-1" />
    </div>
  );
};

import { Temporal } from "@stll/time";
import { useNow } from "@stll/ui/effects";

const MINUTES_PER_DAY = 1440;

/**
 * Red horizontal line showing the current time of day.
 * Used in week-view day cells to indicate "now".
 * Updates every minute.
 */
export const CurrentTimeIndicator = () => {
  const nowMs = useNow(60_000);
  const now = Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(
    Temporal.Now.timeZoneId(),
  );
  const minutesSinceMidnight = now.hour * 60 + now.minute;
  const top = (minutesSinceMidnight / MINUTES_PER_DAY) * 100;

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

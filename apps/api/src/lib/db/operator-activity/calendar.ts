import { Temporal } from "@stll/time";

export const ACTIVITY_TIMEZONE = "Europe/Prague";

type ActivityWeek = {
  weekStart: string;
  since: string;
  until: string;
  partial: boolean;
};

type ActivityWindows = {
  generatedAt: string;
  weeks: ActivityWeek[];
  previousWeekSince: string;
  samePointLastWeek: { since: string; until: string };
};

export const buildActivityWindows = (now: number): ActivityWindows => {
  const instant = Temporal.Instant.fromEpochMilliseconds(now);
  const localNow = instant.toZonedDateTimeISO(ACTIVITY_TIMEZONE);
  const currentWeek = localNow
    .startOfDay()
    .subtract({ days: localNow.dayOfWeek - 1 });
  const weeks: ActivityWeek[] = [];
  for (let offset = 7; offset >= 0; offset -= 1) {
    const start = currentWeek.subtract({ weeks: offset });
    weeks.push({
      weekStart: start.toPlainDate().toString(),
      since: start.toInstant().toString(),
      until:
        offset === 0
          ? instant.toString()
          : start.add({ weeks: 1 }).toInstant().toString(),
      partial: offset === 0,
    });
  }
  return {
    generatedAt: instant.toString(),
    weeks,
    previousWeekSince: currentWeek
      .subtract({ weeks: 8 })
      .toInstant()
      .toString(),
    samePointLastWeek: {
      since: currentWeek.subtract({ weeks: 1 }).toInstant().toString(),
      until: localNow.subtract({ weeks: 1 }).toInstant().toString(),
    },
  };
};

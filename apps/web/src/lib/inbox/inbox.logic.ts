import { Result } from "better-result";

import { SIGNAL_SEVERITIES } from "@stll/api-contract/signals";
import type { SignalSeverity } from "@stll/api-contract/signals";
import { Temporal } from "@stll/time";

/** Local-calendar day key; items created on the same day group together. */
export const inboxDayKey = (createdAt: string): string =>
  Result.try(() =>
    Temporal.Instant.from(createdAt)
      .toZonedDateTimeISO(Temporal.Now.timeZoneId())
      .toPlainDate()
      .toString(),
  ).unwrapOr(createdAt);

/** Higher severity sorts first; ties keep feed order (newest first). */
export const severityRank = (severity: SignalSeverity): number =>
  SIGNAL_SEVERITIES.indexOf(severity);

type DayGroupable = { id: string; createdAt: string; severity: SignalSeverity };

export type InboxDay<T extends DayGroupable> = {
  key: string;
  /** ISO timestamp of the newest item, for the day heading. */
  at: string;
  items: [T, ...T[]];
};

/**
 * Groups a newest-first feed into days (newest day first) and orders each
 * day by severity, preserving recency within a severity.
 */
export const groupInboxDays = <T extends DayGroupable>(
  items: readonly T[],
): InboxDay<T>[] => {
  const days = new Map<string, InboxDay<T>>();
  for (const item of items) {
    const key = inboxDayKey(item.createdAt);
    const day = days.get(key);
    if (day) {
      day.items.push(item);
      continue;
    }
    days.set(key, { key, at: item.createdAt, items: [item] });
  }
  for (const day of days.values()) {
    day.items.sort(
      (a, b) => severityRank(b.severity) - severityRank(a.severity),
    );
  }
  return [...days.values()];
};

/** Snooze presets: tomorrow 09:00 local, or next Monday 09:00 local. */
export const snoozeUntil = (
  preset: "tomorrow" | "next-week",
  now: Date | Temporal.Instant = Temporal.Now.instant(),
): Date => {
  const target = (
    now instanceof Date
      ? Temporal.Instant.fromEpochMilliseconds(now.getTime())
      : now
  )
    .toZonedDateTimeISO(Temporal.Now.timeZoneId())
    .with({
      hour: 9,
      minute: 0,
      second: 0,
      millisecond: 0,
      microsecond: 0,
      nanosecond: 0,
    });
  if (preset === "tomorrow") {
    return new Date(target.add({ days: 1 }).toInstant().epochMilliseconds);
  }
  const daysUntilMonday = (8 - target.dayOfWeek) % 7 || 7;
  return new Date(
    target.add({ days: daysUntilMonday }).toInstant().epochMilliseconds,
  );
};

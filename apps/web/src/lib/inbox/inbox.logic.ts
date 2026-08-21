import { SIGNAL_SEVERITIES } from "@stll/api-contract/signals";
import type { SignalSeverity } from "@stll/api-contract/signals";

/** Local-calendar day key; items created on the same day group together. */
export const inboxDayKey = (createdAt: string): string => {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

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
  now: Date = new Date(),
): Date => {
  const target = new Date(now);
  target.setHours(9, 0, 0, 0);
  if (preset === "tomorrow") {
    target.setDate(target.getDate() + 1);
    return target;
  }
  const daysUntilMonday = (8 - target.getDay()) % 7 || 7;
  target.setDate(target.getDate() + daysUntilMonday);
  return target;
};

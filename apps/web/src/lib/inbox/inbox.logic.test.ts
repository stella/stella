import { describe, expect, test } from "bun:test";

import {
  groupInboxDays,
  inboxDayKey,
  snoozeUntil,
} from "@/lib/inbox/inbox.logic";

const at = (iso: string) => new Date(iso).toISOString();

describe("groupInboxDays", () => {
  test("groups by local day, newest day first, severity within a day", () => {
    const dayA = at("2026-08-21T10:00:00");
    const dayAEarlier = at("2026-08-21T08:00:00");
    const dayB = at("2026-08-20T12:00:00");
    expect(inboxDayKey(dayA)).toBe(inboxDayKey(dayAEarlier));
    expect(inboxDayKey(dayA)).not.toBe(inboxDayKey(dayB));

    const groups = groupInboxDays([
      { id: "1", createdAt: dayA, severity: "info" },
      { id: "2", createdAt: dayAEarlier, severity: "critical" },
      { id: "3", createdAt: dayB, severity: "notice" },
    ]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([
      ["2", "1"],
      ["3"],
    ]);
    expect(groups[0]?.at).toBe(dayA);
  });

  test("keeps recency order inside one severity", () => {
    const groups = groupInboxDays([
      { id: "new", createdAt: at("2026-08-21T10:00:00"), severity: "info" },
      { id: "old", createdAt: at("2026-08-21T09:00:00"), severity: "info" },
    ]);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(["new", "old"]);
  });

  test("unparseable timestamps get their own group instead of NaN", () => {
    const groups = groupInboxDays([
      { id: "a", createdAt: "not-a-date", severity: "info" },
      { id: "b", createdAt: at("2026-08-21T10:00:00"), severity: "info" },
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe("snoozeUntil", () => {
  test("tomorrow is the next calendar day at 09:00 local", () => {
    const now = new Date(2026, 7, 21, 17, 30);
    const until = snoozeUntil("tomorrow", now);
    expect([until.getDate(), until.getHours(), until.getMinutes()]).toEqual([
      22, 9, 0,
    ]);
  });

  test("next week lands on a Monday strictly after today", () => {
    // 2026-08-24 is a Monday.
    const monday = new Date(2026, 7, 24, 10, 0);
    const until = snoozeUntil("next-week", monday);
    expect(until.getDay()).toBe(1);
    expect(until.getDate()).toBe(31);
    const friday = new Date(2026, 7, 21, 10, 0);
    expect(snoozeUntil("next-week", friday).getDate()).toBe(24);
  });
});

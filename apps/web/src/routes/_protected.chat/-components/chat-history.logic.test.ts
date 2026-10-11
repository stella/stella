import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import {
  chatHistoryPeriod,
  chatHistorySearchSchema,
  filterChatHistoryByMatter,
  groupChatHistoryByPeriod,
  hasChatHistoryFilter,
} from "./chat-history.logic";

const instant = (iso: string) => Temporal.Instant.from(iso);

describe("chat history periods", () => {
  test("today is the reader's calendar date, not the last 24 hours", () => {
    const now = instant("2026-10-11T08:00:00Z");
    expect(
      chatHistoryPeriod({
        now,
        timeZone: "UTC",
        updatedAt: "2026-10-11T00:00:00.000Z",
      }),
    ).toBe("today");
    // Nine hours earlier, but on the previous date.
    expect(
      chatHistoryPeriod({
        now,
        timeZone: "UTC",
        updatedAt: "2026-10-10T23:59:59.999Z",
      }),
    ).toBe("previous7Days");
  });

  test("the day boundary follows the reader's time zone", () => {
    // 23:30 UTC on the 10th is already the 11th in Prague (UTC+2 in October)
    // and still the 10th in New York.
    const now = instant("2026-10-11T06:00:00Z");
    const updatedAt = "2026-10-10T23:30:00.000Z";
    expect(
      chatHistoryPeriod({ now, timeZone: "Europe/Prague", updatedAt }),
    ).toBe("today");
    expect(chatHistoryPeriod({ now, timeZone: "UTC", updatedAt })).toBe(
      "previous7Days",
    );
    // At 02:00 in New York it is still the 11th there too, so the same
    // activity (19:30 on the 10th locally) is yesterday.
    expect(
      chatHistoryPeriod({ now, timeZone: "America/New_York", updatedAt }),
    ).toBe("previous7Days");
  });

  test("the previous period covers exactly the seven dates before today", () => {
    const now = instant("2026-10-11T12:00:00Z");
    expect(
      chatHistoryPeriod({
        now,
        timeZone: "UTC",
        updatedAt: "2026-10-04T00:00:00.000Z",
      }),
    ).toBe("previous7Days");
    expect(
      chatHistoryPeriod({
        now,
        timeZone: "UTC",
        updatedAt: "2026-10-03T23:59:59.999Z",
      }),
    ).toBe("older");
  });

  test("a 25-hour daylight-saving day still counts as one date", () => {
    // Prague leaves summer time on 2026-10-25; that day has 25 hours.
    const now = instant("2026-11-01T11:00:00Z");
    expect(
      chatHistoryPeriod({
        now,
        timeZone: "Europe/Prague",
        // 2026-10-25 00:30 in Prague (UTC+2 before the change).
        updatedAt: "2026-10-24T22:30:00.000Z",
      }),
    ).toBe("previous7Days");
    expect(
      chatHistoryPeriod({
        now,
        timeZone: "Europe/Prague",
        // 2026-10-24 23:30 in Prague.
        updatedAt: "2026-10-24T21:30:00.000Z",
      }),
    ).toBe("older");
  });

  test("activity stamped after now counts as today", () => {
    expect(
      chatHistoryPeriod({
        now: instant("2026-10-11T08:00:00Z"),
        timeZone: "UTC",
        updatedAt: "2026-10-12T09:00:00.000Z",
      }),
    ).toBe("today");
  });

  test("accepts Date and ISO string timestamps alike", () => {
    const now = instant("2026-10-11T08:00:00Z");
    const iso = "2026-10-01T08:00:00.000Z";
    expect(
      chatHistoryPeriod({ now, timeZone: "UTC", updatedAt: new Date(iso) }),
    ).toBe(chatHistoryPeriod({ now, timeZone: "UTC", updatedAt: iso }));
  });
});

describe("grouping chat history", () => {
  const now = instant("2026-10-11T12:00:00Z");
  const items = [
    { id: "a", updatedAt: "2026-10-11T10:00:00.000Z" },
    { id: "b", updatedAt: "2026-10-11T01:00:00.000Z" },
    { id: "c", updatedAt: "2026-10-09T10:00:00.000Z" },
    { id: "d", updatedAt: "2026-09-01T10:00:00.000Z" },
    { id: "e", updatedAt: "2025-01-01T10:00:00.000Z" },
  ];

  test("orders periods newest first and keeps item order inside each", () => {
    expect(
      groupChatHistoryByPeriod({ items, now, timeZone: "UTC" }).map((group) => [
        group.period,
        group.items.map((item) => item.id),
      ]),
    ).toEqual([
      ["today", ["a", "b"]],
      ["previous7Days", ["c"]],
      ["older", ["d", "e"]],
    ]);
  });

  test("leaves out empty periods and never loses or duplicates an item", () => {
    const olderOnly = items.slice(3);
    const groups = groupChatHistoryByPeriod({
      items: olderOnly,
      now,
      timeZone: "UTC",
    });
    expect(groups.map((group) => group.period)).toEqual(["older"]);
    expect(groups.flatMap((group) => group.items)).toEqual(olderOnly);
    expect(
      groupChatHistoryByPeriod({ items: [], now, timeZone: "UTC" }),
    ).toEqual([]);
  });
});

describe("filtering chat history by matter", () => {
  const items = [
    { id: "global", scope: "global" as const },
    { id: "in-a", scope: "workspace" as const, workspaceId: "matter-a" },
    { id: "in-b", scope: "workspace" as const, workspaceId: "matter-b" },
  ];

  test("keeps only the chats that live in the chosen matter", () => {
    expect(
      filterChatHistoryByMatter(items, "matter-a").map((item) => item.id),
    ).toEqual(["in-a"]);
  });

  test("keeps every chat when no matter is chosen", () => {
    expect(filterChatHistoryByMatter(items, undefined)).toEqual(items);
  });
});

describe("history search params", () => {
  test("a malformed value falls back to no filter", () => {
    expect(v.parse(chatHistorySearchSchema, { q: 42, matter: ["x"] })).toEqual({
      q: undefined,
      matter: undefined,
    });
  });

  test("a blank search is not a filter; a matter or a term is", () => {
    expect(hasChatHistoryFilter({ q: "   " })).toBe(false);
    expect(hasChatHistoryFilter({})).toBe(false);
    expect(hasChatHistoryFilter({ q: "lease" })).toBe(true);
    expect(hasChatHistoryFilter({ matter: "matter-a" })).toBe(true);
  });
});

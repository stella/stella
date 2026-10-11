import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { APIError } from "@/lib/errors/api";

import {
  chatHistoryPeriod,
  chatHistorySearchSchema,
  groupChatHistoryByPeriod,
  hasChatHistoryFilter,
  isMatterUnavailable,
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
    // Late on the 10th in UTC is already the 11th in Prague, which is ahead
    // of UTC.
    const now = instant("2026-10-11T06:00:00Z");
    const updatedAt = "2026-10-10T23:30:00.000Z";
    expect(
      chatHistoryPeriod({ now, timeZone: "Europe/Prague", updatedAt }),
    ).toBe("today");
    expect(chatHistoryPeriod({ now, timeZone: "UTC", updatedAt })).toBe(
      "previous7Days",
    );
    // New York is behind UTC: "now" is already the 11th there, but the
    // activity falls on the 10th locally, so it is yesterday.
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
        // Early on 2026-10-25 in Prague, seven dates before "now".
        updatedAt: "2026-10-24T22:30:00.000Z",
      }),
    ).toBe("previous7Days");
    expect(
      chatHistoryPeriod({
        now,
        timeZone: "Europe/Prague",
        // Late on 2026-10-24 in Prague, eight dates before "now".
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

describe("an unavailable matter filter", () => {
  const apiError = (status: number) =>
    new APIError({ message: "Workspace not found", status });

  test("is the API's 404 for a filtered read, by status, not message", () => {
    expect(
      isMatterUnavailable({ error: apiError(404), matter: "matter-a" }),
    ).toBe(true);
    expect(
      isMatterUnavailable({ error: apiError(500), matter: "matter-a" }),
    ).toBe(false);
    expect(
      isMatterUnavailable({ error: apiError(404), matter: undefined }),
    ).toBe(false);
    expect(
      isMatterUnavailable({
        error: new TypeError("Workspace not found"),
        matter: "matter-a",
      }),
    ).toBe(false);
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

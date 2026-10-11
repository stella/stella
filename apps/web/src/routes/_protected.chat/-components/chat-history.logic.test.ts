import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";
import { Temporal } from "@stll/time";

import { APIError } from "@/lib/errors/api";

import {
  chatHistoryPeriod,
  chatHistorySearchSchema,
  groupChatHistoryByPeriod,
  hasChatHistoryFilter,
  initialSearchFieldState,
  isMatterUnavailable,
  isStaleSearchWrite,
  syncSearchField,
} from "./chat-history.logic";
import type { SearchFieldState } from "./chat-history.logic";

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

describe("keeping the search field in step with the URL", () => {
  const field = (
    overrides: Partial<SearchFieldState> = {},
  ): SearchFieldState => ({
    ...initialSearchFieldState("lease"),
    ...overrides,
  });

  test("an unchanged URL leaves the field, and its state object, alone", () => {
    const state = field({ value: "lease ren" });
    expect(syncSearchField({ state, urlQuery: "lease" })).toBe(state);
  });

  test("a query from elsewhere replaces what the field shows", () => {
    const state = field();
    expect(syncSearchField({ state, urlQuery: "arbitration" })).toEqual({
      externalChanges: 1,
      lastUrlQuery: "arbitration",
      pending: { status: "idle" },
      value: "arbitration",
    });
    // Back to a page with no query empties the field.
    expect(syncSearchField({ state, urlQuery: undefined }).value).toBe("");
  });

  test("the field's own write landing keeps what the reader typed since", () => {
    const state = field({
      lastUrlQuery: undefined,
      pending: { status: "sent", query: "lea" },
      value: "lease ren",
    });
    expect(syncSearchField({ state, urlQuery: "lea" })).toEqual({
      externalChanges: 0,
      lastUrlQuery: "lea",
      pending: { status: "idle" },
      value: "lease ren",
    });
  });

  test("an own write that cleared the query is told apart from no write", () => {
    const cleared = field({
      pending: { status: "sent", query: undefined },
      value: "le",
    });
    expect(syncSearchField({ state: cleared, urlQuery: undefined }).value).toBe(
      "le",
    );
    const idle = { ...cleared, pending: { status: "idle" as const } };
    expect(syncSearchField({ state: idle, urlQuery: undefined }).value).toBe(
      "",
    );
  });

  test("a query from elsewhere cancels a pending own write", () => {
    const typing = field({
      pending: { status: "sent", query: "leas" },
      value: "leas",
    });
    const scheduledAfter = typing.externalChanges;
    const navigated = syncSearchField({ state: typing, urlQuery: "claim" });

    expect(navigated.value).toBe("claim");
    expect(navigated.pending).toEqual({ status: "idle" });
    // The debounced write typed before the navigation must not fire.
    expect(isStaleSearchWrite({ scheduledAfter, state: navigated })).toBe(true);
  });

  test("an own write landing does not cancel typing that followed it", () => {
    const typing = field({
      lastUrlQuery: undefined,
      pending: { status: "sent", query: "lea" },
      value: "lease",
    });
    const scheduledAfter = typing.externalChanges;
    const landed = syncSearchField({ state: typing, urlQuery: "lea" });

    expect(isStaleSearchWrite({ scheduledAfter, state: landed })).toBe(false);
  });
});

describe("history search params", () => {
  test("a malformed value falls back to no filter", () => {
    expect(v.parse(chatHistorySearchSchema, { q: 42, matter: ["x"] })).toEqual({
      q: undefined,
      matter: undefined,
    });
  });

  test("keeps a search the API accepts and drops a longer one", () => {
    const atLimit = "x".repeat(SEARCH_QUERY_MAX_LENGTH);
    expect(v.parse(chatHistorySearchSchema, { q: atLimit }).q).toBe(atLimit);
    expect(
      v.parse(chatHistorySearchSchema, {
        q: "x".repeat(SEARCH_QUERY_MAX_LENGTH + 1),
      }),
    ).toEqual({ q: undefined, matter: undefined });
  });

  test("keeps only a matter id in the format the API accepts", () => {
    const matterId = "00000000-0000-7000-8000-0000000000a1";
    expect(v.parse(chatHistorySearchSchema, { matter: matterId })).toEqual({
      q: undefined,
      matter: matterId,
    });
    for (const malformed of [
      "",
      "invalid",
      `${matterId}x`,
      "not-a-uuid-at-all",
    ]) {
      expect(
        v.parse(chatHistorySearchSchema, { matter: malformed, q: "lease" }),
      ).toEqual({ q: "lease", matter: undefined });
    }
  });

  test("a blank search is not a filter; a matter or a term is", () => {
    expect(hasChatHistoryFilter({ q: "   " })).toBe(false);
    expect(hasChatHistoryFilter({})).toBe(false);
    expect(hasChatHistoryFilter({ q: "lease" })).toBe(true);
    expect(hasChatHistoryFilter({ matter: "matter-a" })).toBe(true);
  });
});

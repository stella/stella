import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import { encodePaginationCursor } from "@/api/lib/pagination";

import { parseRegistrationQuery } from "./input";

const now = Date.parse("2026-05-01T12:00:00Z");
const since = "2026-05-01T11:00:00Z";
const cursorError = "Invalid cursor; restart without cursor";

const expectInvalid = (
  query: Parameters<typeof parseRegistrationQuery>[0]["query"],
  message: string,
) => {
  const result = parseRegistrationQuery({ query, now });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.status).toBe(400);
    expect(result.error.message).toBe(message);
  }
};

describe("registration query boundaries", () => {
  test("requires a real calendar timestamp with a time zone", () => {
    for (const timestamp of [
      undefined,
      "",
      "invalid",
      "2026-05-01",
      "2026-05-01T11:00:00",
      "2026-04-31T11:00:00Z",
      "2026-02-29T11:00:00Z",
    ]) {
      expectInvalid(
        { since: timestamp },
        "since must be an ISO 8601 timestamp with a time zone",
      );
    }
  });

  test("normalizes equivalent offsets while preserving nanoseconds", () => {
    expect(
      parseRegistrationQuery({
        query: { since: "2026-05-01T13:00:00.123456789+02:00" },
        now,
      }).unwrap(),
    ).toEqual({
      since: "2026-05-01T11:00:00.123456789Z",
      limit: 50,
      cursor: null,
    });
  });

  test("includes both ends of the 31-day window", () => {
    for (const timestamp of ["2026-03-31T12:00:00Z", "2026-05-01T12:00:00Z"]) {
      expect(
        parseRegistrationQuery({ query: { since: timestamp }, now }).unwrap()
          .since,
      ).toBe(timestamp);
    }
  });

  test("rejects timestamps even one nanosecond beyond either end", () => {
    for (const timestamp of [
      "2026-03-31T11:59:59.999999999Z",
      "2026-05-01T12:00:00.000000001Z",
    ]) {
      expectInvalid(
        { since: timestamp },
        "since must be within the past 31 days",
      );
    }
  });

  test("defaults the page size and caps positive safe integers", () => {
    for (const [limit, expected] of [
      [undefined, 50],
      ["1", 1],
      ["100", 100],
      ["101", 100],
      [String(Number.MAX_SAFE_INTEGER), 100],
    ] as const) {
      expect(
        parseRegistrationQuery({ query: { since, limit }, now }).unwrap().limit,
      ).toBe(expected);
    }
  });

  test("rejects empty, noninteger, nonpositive and unsafe limits", () => {
    for (const limit of [
      "",
      " ",
      "0",
      "-1",
      "1.5",
      "NaN",
      "Infinity",
      "invalid",
      "9007199254740992",
    ]) {
      expectInvalid({ since, limit }, "limit must be a positive integer");
    }
  });

  test("binds a cursor to the normalized since instant", () => {
    const cursor = encodePaginationCursor([
      since,
      "2026-05-01T11:30:00Z",
      "registration-1",
    ]);
    expect(
      parseRegistrationQuery({
        query: { since: "2026-05-01T13:00:00+02:00", cursor },
        now,
      }).unwrap().cursor,
    ).toEqual({ createdAt: "2026-05-01T11:30:00Z", id: "registration-1" });
    expectInvalid({ since: "2026-05-01T10:00:00Z", cursor }, cursorError);
  });

  test("round-trips positions from later registrations as the request clock advances", () => {
    for (const elapsed of [1, 1000, 60_000, 24 * 60 * 60 * 1000]) {
      const createdAt = new Date(now + elapsed).toISOString();
      const cursor = encodePaginationCursor([since, createdAt, "later-user"]);
      expectInvalid({ since, cursor }, cursorError);
      expect(
        parseRegistrationQuery({
          query: { since, cursor },
          now: now + elapsed,
        }).unwrap().cursor,
      ).toEqual({
        createdAt: Temporal.Instant.from(createdAt).toString(),
        id: "later-user",
      });
    }
  });

  test("rejects malformed cursor shapes and invalid positions", () => {
    const payloads = [
      [],
      [since],
      [since, since],
      [since, since, "id", "extra"],
      [null, since, "id"],
      [since, null, "id"],
      [since, 1, "id"],
      [since, "2026-04-31T11:00:00Z", "id"],
      [since, "2026-05-01T11:00:00", "id"],
      [since, since, null],
      [since, since, 1],
      [since, since, ""],
      [since, since, "x".repeat(129)],
      [since, since, "identifier\0"],
      [since, "2026-05-01T11:30:00.123456789Z", "id"],
    ];
    for (const payload of payloads) {
      expectInvalid(
        { since, cursor: encodePaginationCursor(payload) },
        cursorError,
      );
    }
    for (const cursor of [
      "",
      "invalid",
      "x".repeat(1025),
      Buffer.from("{}").toString("base64url"),
    ]) {
      expectInvalid({ since, cursor }, cursorError);
    }
  });

  test("accepts cursor bounds and preserves submillisecond position precision", () => {
    for (const createdAt of [
      since,
      "2026-05-01T12:00:00Z",
      "2026-05-01T11:30:00.123456Z",
    ]) {
      const cursor = encodePaginationCursor([
        since,
        createdAt,
        "x".repeat(128),
      ]);
      expect(
        parseRegistrationQuery({ query: { since, cursor }, now }).unwrap()
          .cursor,
      ).toEqual({ createdAt, id: "x".repeat(128) });
    }
  });

  test("rejects cursor positions outside bounds at nanosecond precision", () => {
    for (const createdAt of [
      "2026-05-01T10:59:59.999999999Z",
      "2026-05-01T12:00:00.000000001Z",
    ]) {
      expectInvalid(
        {
          since,
          cursor: encodePaginationCursor([since, createdAt, "registration-1"]),
        },
        cursorError,
      );
    }
    const preciseSince = "2026-05-01T11:00:00.000000002Z";
    expectInvalid(
      {
        since: preciseSince,
        cursor: encodePaginationCursor([
          preciseSince,
          "2026-05-01T11:00:00.000000001Z",
          "registration-1",
        ]),
      },
      cursorError,
    );
  });
});

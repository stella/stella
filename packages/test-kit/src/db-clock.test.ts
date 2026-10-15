import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { createTestClock } from "./clock.ts";
import { clockTimestamp, dbClock } from "./db-clock.ts";

const render = (fragment: SQL) => new PgDialect().sqlToQuery(fragment);

describe("database clock", () => {
  test("offsets are relative to the database's own now()", () => {
    expect(render(dbClock.now())).toEqual({ params: [], sql: "now()" });
    expect(render(dbClock.ago(1500.9))).toEqual({
      params: [1500],
      sql: "now() - $1::integer * interval '1 millisecond'",
    });
    expect(render(dbClock.fromNow(60_000))).toEqual({
      params: [60_000],
      sql: "now() + $1::integer * interval '1 millisecond'",
    });
  });

  test("an injected clock renders as the same instant the test reads", async () => {
    const clock = createTestClock({ start: Date.UTC(2026, 4, 1) });
    await clock.advance(250);
    expect(render(clockTimestamp(clock, -50))).toEqual({
      params: ["2026-05-01T00:00:00.200Z"],
      sql: "$1::timestamptz",
    });
  });
});

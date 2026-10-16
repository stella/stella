import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { createTestClock } from "./clock.ts";
import { clockTimestamp, dbClock } from "./db-clock.ts";

const render = (fragment: SQL) => new PgDialect().sqlToQuery(fragment);

// An in-process Postgres: the offsets must run on the real engine, since a
// rendering test cannot see a cast that overflows at execution time.
const engine = new PGlite();
afterAll(async () => engine.close());

const offsetSeconds = async (fragment: SQL): Promise<number> => {
  const query = render(
    sql`select extract(epoch from (${fragment}) - now())::float8 as seconds`,
  );
  const result = await engine.query<{ seconds: number }>(
    query.sql,
    query.params,
  );
  return result.rows[0]?.seconds ?? Number.NaN;
};

const DAY_MS = 24 * 60 * 60 * 1000;

describe("database clock", () => {
  test("offsets are relative to the database's own now()", async () => {
    expect(render(dbClock.now())).toEqual({ params: [], sql: "now()" });
    expect(await offsetSeconds(dbClock.now())).toBe(0);
    expect(await offsetSeconds(dbClock.ago(1500))).toBe(-1.5);
    expect(await offsetSeconds(dbClock.fromNow(60_000))).toBe(60);
  });

  test("offsets longer than an integer of milliseconds still execute", async () => {
    // 30 days is beyond 2^31 milliseconds.
    expect(30 * DAY_MS).toBeGreaterThan(2 ** 31);
    expect(await offsetSeconds(dbClock.ago(30 * DAY_MS))).toBe(-30 * 86_400);
    expect(await offsetSeconds(dbClock.fromNow(400 * DAY_MS))).toBe(
      400 * 86_400,
    );
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

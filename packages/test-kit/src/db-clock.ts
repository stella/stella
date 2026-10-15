import { type SQL, sql } from "drizzle-orm";

import type { Clock } from "./clock.ts";

/**
 * Database time for tests. Postgres compares rows against its own `now()`,
 * which a test cannot freeze or move from JavaScript. A test that writes a
 * JavaScript timestamp (`new Date(Date.now() - 1000)`) into a column the code
 * compares with `now()` mixes two clocks and passes or fails with the skew
 * between them. Express such values relative to the database clock instead.
 */

// double precision, not integer: an integer cast overflows past ~24.8 days.
const millisecondsInterval = (milliseconds: number): SQL =>
  sql`${milliseconds}::double precision * interval '1 millisecond'`;

export const dbClock = {
  /** The database's current transaction time. */
  now: (): SQL => sql`now()`,
  /** `milliseconds` before the database's now. */
  ago: (milliseconds: number): SQL =>
    sql`now() - ${millisecondsInterval(milliseconds)}`,
  /** `milliseconds` after the database's now. */
  fromNow: (milliseconds: number): SQL =>
    sql`now() + ${millisecondsInterval(milliseconds)}`,
} as const;

/**
 * For code that takes its time from an injected clock rendered into the query
 * as a literal: the clock's instant as a `timestamptz`, so the test and the
 * query read the same clock.
 */
export const clockTimestamp = (clock: Clock, offsetMs = 0): SQL =>
  sql`${new Date(clock.now() + offsetMs).toISOString()}::timestamptz`;

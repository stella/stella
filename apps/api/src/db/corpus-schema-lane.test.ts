import { Panic, Result } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { CASE_LAW_MAINTENANCE_LANE } from "@/api/lib/case-law/maintenance-lane";

import {
  CORPUS_SCHEMA_LANE,
  CORPUS_SCHEMA_LANE_LOCK_SQL,
  CORPUS_SCHEMA_LANE_LOCK_STATEMENTS,
  CORPUS_SCHEMA_LANE_RETRY_MS,
  CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL,
  CORPUS_SCHEMA_LANE_UNLOCK_SQL,
  CorpusSchemaLaneUnavailableError,
  isCorpusSchemaLaneGranted,
  runUnderCorpusSchemaLane,
} from "./corpus-schema-lane";

test("the schema lane is its own key, apart from the operator lane", () => {
  expect(CORPUS_SCHEMA_LANE.domain).toBe(CASE_LAW_MAINTENANCE_LANE.domain);
  expect(CORPUS_SCHEMA_LANE.lane).not.toBe(CASE_LAW_MAINTENANCE_LANE.lane);
});

test("the shared side is a transaction-scoped try and the exclusive side is a session pair", () => {
  const key = `hashtext('${CORPUS_SCHEMA_LANE.domain}'), hashtext('${CORPUS_SCHEMA_LANE.lane}')`;
  // A try, never a wait: a transaction blocked on the lane would hold a
  // snapshot that a concurrent index build in the upgrade waits on.
  expect(CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL).toBe(
    `SELECT pg_try_advisory_xact_lock_shared(${key}) AS "granted"`,
  );
  expect(CORPUS_SCHEMA_LANE_LOCK_SQL).toBe(`SELECT pg_advisory_lock(${key})`);
  expect(CORPUS_SCHEMA_LANE_UNLOCK_SQL).toBe(
    `SELECT pg_advisory_unlock(${key})`,
  );
});

test("a try result is granted only when its row says so, under either driver shape", () => {
  expect(isCorpusSchemaLaneGranted([{ granted: true }])).toBe(true);
  expect(isCorpusSchemaLaneGranted({ rows: [{ granted: true }] })).toBe(true);
  expect(isCorpusSchemaLaneGranted([{ granted: false }])).toBe(false);
  expect(isCorpusSchemaLaneGranted([{ granted: "t" }])).toBe(false);
  expect(isCorpusSchemaLaneGranted([])).toBe(false);
  expect(isCorpusSchemaLaneGranted({ rows: [] })).toBe(false);
});

test("a try result in neither driver shape is a fault, not a refusal", () => {
  expect(() => isCorpusSchemaLaneGranted(undefined)).toThrow(Panic);
});

type FakeTransaction = { execute: (query: string) => Promise<unknown> };

/** A database whose lane answers come from a script. */
const scriptedDatabase = (grants: readonly boolean[]) => {
  const remaining = [...grants];
  const attempts: string[] = [];
  const database = {
    transaction: async <TResult>(
      fn: (tx: FakeTransaction) => Promise<TResult>,
    ): Promise<TResult> => {
      attempts.push("begin");
      const result = await fn({
        execute: async (query: string) => {
          attempts.push(query);
          return [{ granted: remaining.shift() ?? true }];
        },
      });
      attempts.push("commit");
      return result;
    },
  };
  return { attempts, database };
};

test("a refused try ends its transaction and sleeps before the next one", async () => {
  const { attempts, database } = scriptedDatabase([false, false, true]);
  const sleeps: number[] = [];
  const value = await runUnderCorpusSchemaLane({
    database,
    work: async (tx) => {
      await tx.execute("UPDATE case_law_decisions SET x = 1");
      return "done";
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  expect(value).toBe("done");
  expect(sleeps).toEqual([
    CORPUS_SCHEMA_LANE_RETRY_MS,
    CORPUS_SCHEMA_LANE_RETRY_MS,
  ]);
  // Two empty transactions, then the one that holds the lane and does work.
  expect(attempts).toEqual([
    "begin",
    CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL,
    "commit",
    "begin",
    CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL,
    "commit",
    "begin",
    CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL,
    "UPDATE case_law_decisions SET x = 1",
    "commit",
  ]);
});

test("a batch that outlives its budget fails instead of entering the lane late", async () => {
  const { database } = scriptedDatabase([false, false, false, false]);
  let ran = false;
  const rejection: unknown = await runUnderCorpusSchemaLane({
    database,
    work: async () => {
      ran = true;
    },
    laneWaitMs: CORPUS_SCHEMA_LANE_RETRY_MS * 2,
    sleep: async () => {},
  }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(CorpusSchemaLaneUnavailableError);
  expect(rejection).toMatchObject({
    waitedMs: CORPUS_SCHEMA_LANE_RETRY_MS * 2,
  });
  expect(ran).toBe(false);
});

test("a budget that is not a multiple of the retry pause is honoured exactly", async () => {
  const granted = scriptedDatabase([false, false, true]);
  const sleeps: number[] = [];
  let grantedNow = 0;
  const value = await runUnderCorpusSchemaLane({
    database: granted.database,
    work: async () => "done",
    laneWaitMs: 300,
    clock: () => grantedNow,
    sleep: async (ms) => {
      grantedNow += ms;
      sleeps.push(ms);
    },
  });
  expect(value).toBe("done");
  // The second pause is cut to the 50 ms left, so the last try lands on the
  // budget, never past it.
  expect(sleeps).toEqual([CORPUS_SCHEMA_LANE_RETRY_MS, 50]);

  const refused = scriptedDatabase([false, false, false]);
  let refusedNow = 0;
  const rejection: unknown = await runUnderCorpusSchemaLane({
    database: refused.database,
    work: async () => "done",
    laneWaitMs: 300,
    clock: () => refusedNow,
    sleep: async (ms) => {
      refusedNow += ms;
    },
  }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toMatchObject({ waitedMs: 300 });
  expect(refused.attempts.filter((step) => step === "begin")).toHaveLength(3);
});

test("the exclusive wait runs with the statement timeout off and restores it once held", () => {
  const [lift, lock, restore] = CORPUS_SCHEMA_LANE_LOCK_STATEMENTS;
  expect(lift).toBe("SET statement_timeout = '0'");
  expect(lock).toBe(CORPUS_SCHEMA_LANE_LOCK_SQL);
  expect(restore).toBe("RESET statement_timeout");
});

// The entrypoint delegates to the runner, which owns migration SQL and the
// lane's session lock. Pin the ordering and ensure release stays in finally.
test("the migration runner takes the lane before SQL and releases it in finally", () => {
  const source = readFileSync(
    nodePath.resolve(import.meta.dir, "migration-runner.ts"),
    "utf-8",
  );
  const positions = [
    "CORPUS_SCHEMA_LANE_LOCK_STATEMENTS;",
    "await connection.unsafe(liftTimeout);",
    "await connection.unsafe(takeLane);",
    "laneHeld = true;",
    "await connection.unsafe(restoreTimeout);",
    "await pgCoreMigrate(migrations, database",
  ].map((needle) => {
    const at = source.indexOf(needle);
    expect(at, needle).toBeGreaterThan(-1);
    return at;
  });
  expect(positions).toEqual([...positions].toSorted((a, b) => a - b));
  expect(source).not.toContain("CORPUS_SCHEMA_LANE_LOCK_SQL");

  const migrationAt = source.indexOf(
    "await pgCoreMigrate(migrations, database",
  );
  const finallyAt = source.indexOf("} finally {");
  expect(finallyAt).toBeGreaterThan(migrationAt);
  expect(source.slice(finallyAt)).toContain(
    "await connection.unsafe(CORPUS_SCHEMA_LANE_UNLOCK_SQL);",
  );
});

test("schema-lane budgets include time spent acquiring a transaction", async () => {
  let now = 0;
  let started = false;
  const database = {
    transaction: async <T>(work: (tx: FakeTransaction) => Promise<T>) => {
      now = 300;
      return await work({ execute: async () => [{ granted: true }] });
    },
  };
  const outcome = await Result.tryPromise({
    try: async () =>
      await runUnderCorpusSchemaLane({
        database,
        clock: () => now,
        laneWaitMs: 250,
        work: async () => {
          started = true;
        },
      }),
    catch: (cause) => cause,
  });
  expect(outcome.isErr()).toBe(true);
  if (outcome.isErr()) {
    expect(outcome.error).toBeInstanceOf(CorpusSchemaLaneUnavailableError);
  }
  expect(started).toBe(false);
});

test("a cycle abort interrupts schema-lane pacing without starting corpus work", async () => {
  const abort = new AbortController();
  let started = false;
  const { database } = scriptedDatabase([false, true]);
  const waiting = runUnderCorpusSchemaLane({
    database,
    signal: abort.signal,
    laneWaitMs: 5000,
    work: async () => {
      started = true;
    },
  });
  abort.abort();
  const outcome = await Result.tryPromise({
    try: async () => await waiting,
    catch: (cause) => cause,
  });
  expect(outcome.isErr()).toBe(true);
  if (outcome.isErr()) {
    expect(outcome.error).toMatchObject({ name: "AbortError" });
  }
  expect(started).toBe(false);
});

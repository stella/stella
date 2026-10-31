import { panic } from "better-result";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { createTestState } from "@stll/test-state";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import { schedulerJobs } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import { SCHEDULER_BACKFILL_IDS } from "@/api/lib/scheduler/backfill-config";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import {
  BACKFILL_CASE_LAW_PARSED_INPUT_STATE_TASK,
  createCaseLawParsedInputStateBackfill,
} from "./case-law-parsed-input-state-backfill";

const state = createTestState({ file: import.meta.path, config: {} });

const JOB_ID = SCHEDULER_BACKFILL_IDS.parsedInputState;
const SOURCE_ID = "0198e331-e578-7000-8000-000000000a01";
const decisionId = (n: number) =>
  `0198e331-e578-7000-8000-${n.toString(16).padStart(12, "0")}`;
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: SchedulerDb;

state.beforeAll(async () => {
  client = await createTestPglite();
  db = asTestRaw<SchedulerDb>(drizzle({ client }));
  await client.query(
    "INSERT INTO case_law_sources (id, adapter_key, name) VALUES ($1, 'parsed-state-backfill', 'Parsed state fixture')",
    [SOURCE_ID],
  );
});
afterAll(async () => await client.close());
beforeEach(async () => {
  await client.exec(
    "DELETE FROM case_law_decisions; DELETE FROM database_backfill_states; DELETE FROM system_audit_runs; DELETE FROM scheduler_jobs",
  );
  await db.insert(schedulerJobs).values({
    id: JOB_ID,
    task: BACKFILL_CASE_LAW_PARSED_INPUT_STATE_TASK,
    description: "Parsed input state backfill fixture",
    lockedBy: "test-lease",
    nextRunAt: new Date("2026-10-30T12:00:00Z"),
    schedule: { type: "interval", everyMs: 300_000 },
  });
});

const insertDecisions = async () => {
  // Only the isolated test DB can suppress this trigger: historical rows
  // predate it, while every ordinary insert now derives a non-NULL state.
  await client.exec(
    "ALTER TABLE case_law_decisions DISABLE TRIGGER case_law_decisions_zz_parsed_input_state",
  );
  await client.query(
    `INSERT INTO case_law_decisions
    (id, source_id, case_number, court, country, language,
     source_hash, source_hash_version, source_raw_s3_key,
     parsed_source_hash, parsed_source_hash_version, parsed_source_raw_s3_key, parsed_input_state)
    VALUES
      ($1, $5, 'one', 'fixture court', 'POL', 'pl', 'h1', 1, 'raw/1', 'h1', 1, 'raw/1', NULL),
      ($2, $5, 'two', 'fixture court', 'POL', 'pl', 'h2', 1, 'raw/2', 'h1', 1, 'raw/1', NULL),
      ($3, $5, 'three', 'fixture court', 'POL', 'pl', NULL, 0, NULL, NULL, NULL, NULL, NULL),
      ($4, $5, 'four', 'fixture court', 'POL', 'pl', 'h4', 1, 'raw/4', 'h4', 1, 'raw/4', 'parsed')`,
    [1, 2, 3, 4].map(decisionId).concat(SOURCE_ID),
  );
  await client.exec(
    "ALTER TABLE case_law_decisions ENABLE TRIGGER case_law_decisions_zz_parsed_input_state",
  );
};

const rows = async () =>
  (
    await client.query<{
      row: Record<string, unknown>;
      stored: string | null;
      derived: string;
      xmin: string;
    }>(`
  SELECT to_jsonb(d) AS row, parsed_input_state AS stored,
    case_law_parsed_input_state(source_hash, source_hash_version, source_raw_s3_key,
      parsed_source_hash, parsed_source_hash_version, parsed_source_raw_s3_key) AS derived,
    xmin::text AS xmin
  FROM case_law_decisions d ORDER BY id
`)
  ).rows;

const fixture = (
  options: Partial<
    Parameters<typeof createCaseLawParsedInputStateBackfill>[0]
  > = {},
) => {
  const events: string[] = [];
  const continuations: Date[] = [];
  const task = createCaseLawParsedInputStateBackfill({
    pageRows: 2,
    readVerdict: async () => ({ kind: "normal", signals: [] }),
    observeStatus: () => {},
    clock: () => Date.parse("2026-10-30T12:00:00Z"),
    // PGlite has one session and cannot exercise PostgreSQL advisory locks.
    createRuntime: (runtimeOptions) =>
      createScriptBackfillRuntime({
        ...runtimeOptions,
        slot: { tryAcquire: async () => true, release: () => {} },
      }),
    ...options,
  });
  return {
    events,
    continuations,
    run: async () => {
      const job =
        (
          await db
            .select()
            .from(schedulerJobs)
            .where(eq(schedulerJobs.id, JOB_ID))
        ).at(0) ?? panic("Missing fixture job");
      const result = await task({
        db,
        job,
        payload: job.payload,
        dueAt: DueSlot.of(job),
        runId: createSafeId<"schedulerJobRun">(),
        signal: new AbortController().signal,
        logger: {
          ...logger,
          info: (event) => {
            events.push(event);
          },
        },
        scheduleContinuation: (at) => {
          continuations.push(at);
        },
      });
      expect(result?.isErr()).not.toBe(true);
    },
  };
};

const checkpoint = async () =>
  (
    await client.query<{
      cursor: string | null;
      batch: { heldSince: number | null };
    }>("SELECT cursor, batch FROM database_backfill_states WHERE name = $1", [
      JOB_ID,
    ])
  ).rows.at(0);

test("derives only NULL states in cursor pages and retires durably after the full pass", async () => {
  await insertDecisions();
  const before = await rows();
  const first = fixture();
  await first.run();
  expect((await rows()).map(({ stored }) => stored)).toEqual([
    "parsed",
    "unparsed",
    null,
    "parsed",
  ]);
  expect((await checkpoint())?.cursor).toBe(decisionId(2));
  expect(first.continuations).toHaveLength(1);

  // A fresh task instance and scheduler run resume the persisted runtime cursor.
  const resumed = fixture();
  await resumed.run();
  expect((await checkpoint())?.cursor).toBe(decisionId(4));
  const derived = await rows();
  expect(derived.map(({ stored }) => stored)).toEqual(
    derived.map(({ derived: expected }) => expected),
  );
  expect(
    derived.map(({ row: { parsed_input_state, ...rest } }) => rest),
  ).toEqual(before.map(({ row: { parsed_input_state, ...rest } }) => rest));
  expect(derived.at(3)?.xmin).toBe(before.at(3)?.xmin);
  expect(resumed.continuations).toHaveLength(1);
  await resumed.run();
  expect(resumed.continuations).toHaveLength(1);
  expect(
    (
      await db.select().from(schedulerJobs).where(eq(schedulerJobs.id, JOB_ID))
    ).at(0),
  ).toMatchObject({ enabled: false, payload: { completed: true } });
  const completedCheckpoint = await checkpoint();
  expect(completedCheckpoint?.cursor).toBeNull();
  const completedRows = await rows();
  const later = fixture({
    createRuntime: () =>
      panic("Completed backfill must not construct a runtime"),
  });
  await later.run();
  expect(await rows()).toEqual(completedRows);
  expect(await checkpoint()).toEqual(completedCheckpoint);
  expect(later.events).toEqual([]);
});

test("kill switch logs once without touching the database", async () => {
  await insertDecisions();
  const before = await rows();
  state.setEnv("CASE_LAW_PARSED_INPUT_STATE_BACKFILL_KILL_SWITCH", "true");
  const killed = fixture({
    createRuntime: () => panic("Kill switch must precede database work"),
  });
  await killed.run();
  expect(killed.events).toEqual([
    "scheduler.case_law_parsed_input_state_backfill_disabled",
  ]);
  expect(killed.continuations).toEqual([]);
  expect(await checkpoint()).toBeUndefined();
  expect(await rows()).toEqual(before);
});

test("a held database gate records a hold without rewriting decisions or advancing the cursor", async () => {
  await insertDecisions();
  const before = await rows();
  const held = fixture({
    readVerdict: async () => ({ kind: "stop", signals: [] }),
  });
  await held.run();
  expect(held.events).toEqual([
    "scheduler.case_law_parsed_input_state_backfill_held",
  ]);
  expect(held.continuations).toEqual([]);
  expect(await rows()).toEqual(before);
  expect((await checkpoint())?.cursor).toBeNull();
  expect((await checkpoint())?.batch.heldSince).not.toBeNull();
  expect(
    (
      await db.select().from(schedulerJobs).where(eq(schedulerJobs.id, JOB_ID))
    ).at(0),
  ).toMatchObject({ enabled: true, payload: null });
});

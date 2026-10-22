import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { boundSchedulerPauses } from "@/api/lib/scheduler/jobs";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * Bounding scheduler pauses on rows written before the bound.
 *
 * The shared test database runs every migration on empty tables, so it never
 * holds an open-ended pause. This suite builds `scheduler_jobs` as it was
 * before the migration, seeds every pause shape, runs the migration file and
 * then the boot step that bounds those pauses.
 */

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20261022120000_scheduler_pause_bound/migration.sql",
);

const PRE_BOUND_SCHEMA = `
CREATE TABLE scheduler_jobs (
  id text PRIMARY KEY,
  task text NOT NULL,
  description text,
  schedule jsonb NOT NULL,
  payload jsonb,
  enabled boolean NOT NULL DEFAULT true,
  paused_by text,
  paused_until timestamp with time zone,
  pause_reason text,
  next_run_at timestamp with time zone NOT NULL,
  locked_until timestamp with time zone,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT scheduler_jobs_pause_attribution_check CHECK (
    paused_until IS NULL OR (
      paused_by IS NOT NULL AND length(btrim(paused_by)) > 0
      AND pause_reason IS NOT NULL AND length(btrim(pause_reason)) >= 8
    )
  )
);
`;

// Every pause shape a row can hold before the bound.
const SEED = `
INSERT INTO scheduler_jobs
  (id, task, description, schedule, payload, paused_by, paused_until, pause_reason, next_run_at)
VALUES
  ('job.infinite', 'task.a', 'open-ended', '{"type":"interval","everyMs":60000}', '{"k":1}',
    'operator', 'infinity', 'Incident hold reason', '2026-10-01T00:00:00Z'),
  ('job.long', 'task.b', 'ten days', '{"type":"interval","everyMs":60000}', NULL,
    'operator', now() + interval '10 days', 'Long maintenance', '2026-10-01T00:00:00Z'),
  ('job.active', 'task.c', 'ten hours', '{"type":"interval","everyMs":60000}', NULL,
    'operator', now() + interval '10 hours', 'Short maintenance', '2026-10-01T00:00:00Z'),
  ('job.past', 'task.d', 'elapsed', '{"type":"interval","everyMs":60000}', NULL,
    'operator', now() - interval '1 hour', 'Elapsed maintenance', '2026-10-01T00:00:00Z'),
  ('job.negative', 'task.e', 'never paused', '{"type":"interval","everyMs":60000}', NULL,
    'operator', '-infinity', 'Negative infinity', '2026-10-01T00:00:00Z'),
  ('job.unpaused', 'task.f', 'running', '{"type":"interval","everyMs":60000}', NULL,
    NULL, NULL, NULL, '2026-10-01T00:00:00Z')
`;

// The shape of the boot upsert: refresh declared fields, keep the pause.
const BOOT_UPSERT = `
INSERT INTO scheduler_jobs (id, task, description, schedule, enabled, next_run_at)
SELECT id, task, 'refreshed', schedule, true, now() FROM scheduler_jobs
ON CONFLICT (id) DO UPDATE SET
  description = EXCLUDED.description,
  enabled = EXCLUDED.enabled,
  schedule = EXCLUDED.schedule,
  task = EXCLUDED.task
`;

const migrationSql = readFileSync(MIGRATION_PATH, "utf-8").replaceAll(
  "--> statement-breakpoint",
  "",
);

type Snapshot = Record<string, { row: unknown; pausedUntil: string | null }>;

// Each row without the columns a bound may change, plus the deadline as text.
const snapshot = async (database: PGlite): Promise<Snapshot> => {
  const result = await database.query<{
    id: string;
    row: unknown;
    paused_until: string | null;
  }>(
    `SELECT id,
       to_jsonb(j) - 'paused_until' - 'paused_since' - 'updated_at' AS row,
       paused_until::text AS paused_until
     FROM scheduler_jobs j ORDER BY id`,
  );
  return Object.fromEntries(
    result.rows.map(({ id, row, paused_until }) => [
      id,
      { row, pausedUntil: paused_until },
    ]),
  );
};

const rejectionFrom = async (run: Promise<unknown>): Promise<unknown> =>
  await run.then(
    () => null,
    (error: unknown) => error,
  );

test("the migration changes no row; the boot bound ends overlong pauses at the maximum without losing anything", async () => {
  const database = new PGlite();
  try {
    await database.exec(PRE_BOUND_SCHEMA);
    await database.exec(SEED);
    const before = await snapshot(database);

    await database.exec(migrationSql);
    expect(await snapshot(database)).toEqual(before);

    // Why the bound runs before the boot upsert: the check refuses any
    // update of a row that still holds an open-ended deadline.
    expect(await rejectionFrom(database.exec(BOOT_UPSERT))).toMatchObject({
      message: expect.stringContaining("scheduler_jobs_pause_finite_check"),
    });

    const bounded = await boundSchedulerPauses(
      asTestRaw<SchedulerDb>(drizzle({ client: database })),
    );
    expect(bounded.toSorted()).toEqual(["job.infinite", "job.long"]);

    const after = await snapshot(database);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const id of Object.keys(before)) {
      expect(after[id]?.row).toEqual(before[id]?.row);
    }
    for (const id of ["job.active", "job.past", "job.unpaused"]) {
      expect(after[id]?.pausedUntil).toBe(before[id]?.pausedUntil ?? null);
    }
    expect(after["job.negative"]?.pausedUntil).toBeNull();
    const within = await database.query<{ id: string; within: boolean }>(
      `SELECT id, paused_until > now() + interval '71 hours'
         AND paused_until <= now() + interval '72 hours' AS within
       FROM scheduler_jobs WHERE id IN ('job.infinite', 'job.long') ORDER BY id`,
    );
    expect(within.rows).toEqual([
      { id: "job.infinite", within: true },
      { id: "job.long", within: true },
    ]);
    // A bounded pause records no start, so the pause audit reports it.
    const starts = await database.query<{ count: number | string }>(
      "SELECT count(*) AS count FROM scheduler_jobs WHERE paused_since IS NOT NULL",
    );
    expect(Number(starts.rows.at(0)?.count)).toBe(0);

    await database.exec(BOOT_UPSERT);
    const refreshed = await database.query<{ count: number | string }>(
      "SELECT count(*) AS count FROM scheduler_jobs WHERE description = 'refreshed'",
    );
    expect(Number(refreshed.rows.at(0)?.count)).toBe(6);

    // A second boot finds nothing left to bound.
    expect(
      await boundSchedulerPauses(
        asTestRaw<SchedulerDb>(drizzle({ client: database })),
      ),
    ).toEqual([]);

    expect(
      await rejectionFrom(
        database.exec(
          `UPDATE scheduler_jobs SET paused_until = 'infinity' WHERE id = 'job.active'`,
        ),
      ),
    ).toMatchObject({ message: expect.stringContaining("72-hour maximum") });
  } finally {
    await database.close();
  }
});

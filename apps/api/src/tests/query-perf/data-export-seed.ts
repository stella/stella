import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { DATA_EXPORT_MAX_FAILURES, schedulerJobs } from "@/api/db/schema";
import { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import { MAINTAIN_DATA_EXPORTS_TASK } from "@/api/lib/scheduler/tasks/data-export-maintenance";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { createLeasedSchedulerJobFixture } from "@/api/tests/helpers/leased-scheduler-job";

export type DataExportScenario = {
  type: "data-exports";
  rows: number;
  cohort: "quiet" | "transitions" | "queued";
};

const USER_ID = "01990000-00c0-7000-8000-000000000001";

/** One active export per organization, with dense cutoff ties and real state indexes. */
export const seedDataExportScenario = async (
  database: GatedTestDb,
  { rows, cohort }: DataExportScenario,
) => {
  // A measured checkpoint must target a real leased scheduler row.
  const job =
    DECLARED_SCHEDULER_JOBS.find(
      ({ task }) => task === MAINTAIN_DATA_EXPORTS_TASK,
    ) ?? panic("Data-export maintenance has no declared job");
  const leasedJob = createLeasedSchedulerJobFixture({
    id: job.id,
    task: job.task,
    nextRunAt: new Date("2026-01-10T12:00:00Z"),
  });
  await database.insert(schedulerJobs).values(leasedJob).onConflictDoUpdate({
    target: schedulerJobs.id,
    set: leasedJob,
  });
  await database.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${USER_ID}, 'Export measurement', 'export-measurement@example.test', true, now(), now())
    ON CONFLICT (id) DO NOTHING`);
  await database.execute(sql`INSERT INTO organization (id, name, slug, created_at)
    SELECT md5('export-org-' || i)::uuid, 'Export measurement', 'export-measurement-' || i, now()
    FROM generate_series(1, ${rows}::integer) AS i ON CONFLICT (id) DO NOTHING`);
  await database.execute(
    sql`TRUNCATE organization_data_exports, audit_logs, system_audit_runs`,
  );
  // Ordered UUIDs keep both alternating stale-run outcomes in each bounded page.
  // FORCE RLS also applies to the fixture owner; permit only seed inserts,
  // then remove the fixture policy before any measured task runs.
  await database.execute(sql`CREATE POLICY query_perf_export_seed ON organization_data_exports
    FOR INSERT TO CURRENT_USER WITH CHECK (true)`);
  try {
    await database.execute(sql`INSERT INTO organization_data_exports
    (id, organization_id, requested_by, version_scope, status, attempt, failures,
      created_at, heartbeat_at, expires_at)
    SELECT ('01990000-00c1-7000-8000-' || lpad(to_hex(i), 12, '0'))::uuid, md5('export-org-' || i)::uuid,
      CASE WHEN ${cohort} = 'transitions' AND i % 3 = 2 THEN NULL ELSE ${USER_ID} END,
      'all',
      CASE WHEN ${cohort} = 'queued' THEN 'queued'
        WHEN i % 3 = 0 THEN 'ready' WHEN i % 3 = 1 THEN 'running' ELSE 'queued' END,
      1, CASE WHEN i % 2 = 0 THEN ${DATA_EXPORT_MAX_FAILURES - 1} ELSE 0 END,
      CASE WHEN ${cohort} = 'quiet' THEN '2026-01-10T12:00:00Z'::timestamptz ELSE '2026-01-01T12:00:00Z'::timestamptz END,
      CASE WHEN ${cohort} = 'quiet' THEN '2026-01-10T12:00:00Z'::timestamptz ELSE '2026-01-01T12:00:00Z'::timestamptz END,
      CASE WHEN ${cohort} = 'quiet' THEN '2026-02-01T12:00:00Z'::timestamptz ELSE '2026-01-01T12:00:00Z'::timestamptz END
    FROM generate_series(1, ${rows}::integer) AS i`);
  } finally {
    await database.execute(
      sql`DROP POLICY query_perf_export_seed ON organization_data_exports`,
    );
  }
  await database.execute(sql`VACUUM (ANALYZE) organization_data_exports`);
};

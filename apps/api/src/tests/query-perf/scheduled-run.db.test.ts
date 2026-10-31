import { expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  auditLogs,
  organizationDataExports,
  systemAuditRuns,
} from "@/api/db/schema";
import { QUEUE_REQUEUE_OUTCOME } from "@/api/lib/bullmq-requeue";
import {
  DATA_EXPORT_HANDOFF_PAGE_SIZE,
  DATA_EXPORT_MAX_HANDOFF_PAGES,
  MAINTAIN_DATA_EXPORTS_TASK,
} from "@/api/lib/scheduler/tasks/data-export-maintenance";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { withIsolatedPostgresCluster } from "@/api/tests/isolated-postgres-cluster";

import { seedDataExportScenario } from "./data-export-seed";
import { measureScheduledJobRun } from "./scheduled-run";

// timeout: this test provisions an isolated PostgreSQL cluster and applies the complete migration chain.
test("export measurement executes every cohort once without replaying writes", async () => {
  await withIsolatedPostgresCluster(
    {
      prefix: "export-measurement",
      database: "stella",
      user: "measurement_admin",
      password: "fixture",
    },
    async (databaseUrl) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const migration = Bun.spawn({
          cmd: [
            process.execPath,
            "--no-env-file",
            path.resolve(import.meta.dir, "../../db/migrate.ts"),
          ],
          env: {
            DATABASE_URL: databaseUrl,
            DB_LOAD_GATE_EBS_SIGNAL: "disabled",
            NODE_ENV: "test",
            PATH: process.env["PATH"] ?? "",
          },
          stdout: "pipe",
          stderr: "pipe",
          signal: AbortSignal.timeout(60_000),
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(migration.stdout).text(),
          new Response(migration.stderr).text(),
          migration.exited,
        ]);
        expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
        const { db } = openClient();
        const exportRows = async () =>
          await db
            .select({
              id: organizationDataExports.id,
              status: organizationDataExports.status,
              attempt: organizationDataExports.attempt,
              failures: organizationDataExports.failures,
            })
            .from(organizationDataExports)
            .orderBy(asc(organizationDataExports.id))
            .limit(600);
        for (const cohort of ["quiet", "transitions", "queued"] as const) {
          const scenario = { type: "data-exports", rows: 600, cohort } as const;
          await seedDataExportScenario(db, scenario);
          const original = await exportRows();
          let enqueued = 0;
          const measured = await measureScheduledJobRun({
            database: db,
            jobId: "dataExports.maintain.fiveMinute",
            task: MAINTAIN_DATA_EXPORTS_TASK,
            dataExportMaintenance: {
              handoffPageSize: DATA_EXPORT_HANDOFF_PAGE_SIZE,
              enqueue: async () => {
                enqueued += 1;
                return QUEUE_REQUEUE_OUTCOME.REQUEUED;
              },
            },
          });
          expect(
            measured.planViolations.filter(
              ({ kind }) =>
                kind === "large-scan" || kind === "deadline-missing",
            ),
          ).toEqual([]);
          expect(await db.$count(systemAuditRuns)).toBe(1);
          const changed = await exportRows();
          const audits = await db.$count(auditLogs);
          if (cohort === "transitions") {
            expect(changed).not.toEqual(original);
            expect(audits).toBeGreaterThan(0);
            for (const row of changed) {
              const before = original.find(({ id }) => id === row.id);
              expect(before).toBeDefined();
              if (before !== undefined) {
                expect(row.attempt - before.attempt).toBeLessThanOrEqual(1);
                expect(row.failures - before.failures).toBeLessThanOrEqual(1);
              }
            }
          } else {
            expect(changed).toEqual(original);
            expect(audits).toBe(0);
          }
          expect(measured.statements.length).toBeGreaterThan(0);
          expect(
            measured.statements.some(({ statement }) =>
              /^\s*explain\b/iu.test(statement),
            ),
          ).toBe(false);
          if (cohort === "queued") {
            expect(enqueued).toBe(
              DATA_EXPORT_HANDOFF_PAGE_SIZE * DATA_EXPORT_MAX_HANDOFF_PAGES,
            );
          }
          if (cohort === "quiet") {
            expect(enqueued).toBe(0);
          }
          if (cohort === "transitions") {
            expect(enqueued).toBeGreaterThan(0);
          }
        }
        expect(
          await rejectionOf(
            measureScheduledJobRun({
              database: db,
              jobId: "dataExports.maintain.fiveMinute",
              task: "requests.sweepReceipts",
            }),
          ),
        ).toMatchObject({
          message: expect.stringContaining("dataExports.maintain"),
        });
      });
    },
  );
}, 120_000);

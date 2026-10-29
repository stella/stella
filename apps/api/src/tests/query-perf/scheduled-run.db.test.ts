import { TaggedError } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import { databaseRelations } from "@/api/db/database-relations";
import { auditLogs, organizationDataExports } from "@/api/db/schema";
import { QUEUE_REQUEUE_OUTCOME } from "@/api/lib/bullmq-requeue";
import {
  DATA_EXPORT_HANDOFF_PAGE_SIZE,
  DATA_EXPORT_MAX_HANDOFF_PAGES,
  MAINTAIN_DATA_EXPORTS_TASK,
} from "@/api/lib/scheduler/tasks/data-export-maintenance";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { seedDataExportScenario } from "./data-export-seed";
import {
  captureScheduledJobRun,
  measureScheduledJobRun,
} from "./scheduled-run";
import type { CapturedStatement } from "./scheduled-run";

const createFixture = async () => {
  const client = await createTestPglite();
  return { client, db: drizzle({ client, relations: databaseRelations }) };
};
let fixture: Awaited<ReturnType<typeof createFixture>>;
beforeAll(async () => {
  fixture = await createFixture();
});
afterAll(async () => {
  await fixture.client.close();
});

const exportRows = async () =>
  await fixture.db
    .select({
      id: organizationDataExports.id,
      status: organizationDataExports.status,
      attempt: organizationDataExports.attempt,
      failures: organizationDataExports.failures,
    })
    .from(organizationDataExports)
    .orderBy(asc(organizationDataExports.id))
    .limit(600);

// These are capture/reset behavior checks. PostgreSQL CI owns EXPLAIN and budgets.
test.each(["quiet", "transitions", "queued"] as const)(
  "registered export maintenance captures real %s work and restores its fixture before replay",
  async (cohort) => {
    const db = fixture.db;
    const scenario = { type: "data-exports", rows: 600, cohort } as const;
    const reset = async () =>
      await seedDataExportScenario(asTestRaw<GatedTestDb>(db), scenario);
    await reset();
    const original = await exportRows();
    const statements: CapturedStatement[] = [];
    const logged = drizzle({
      client: fixture.client,
      relations: databaseRelations,
      logger: {
        logQuery: (text, params) => {
          statements.push({ text, params });
        },
      },
    });
    let resets = 0;
    let enqueued = 0;
    await captureScheduledJobRun({
      database: asTestRaw<SchedulerDb>(logged),
      jobId: "dataExports.maintain.fiveMinute",
      task: MAINTAIN_DATA_EXPORTS_TASK,
      statements,
      dataExportMaintenance: {
        handoffPageSize: DATA_EXPORT_HANDOFF_PAGE_SIZE,
        enqueue: async () => {
          enqueued += 1;
          return QUEUE_REQUEUE_OUTCOME.REQUEUED;
        },
      },
      resetAfterCapture: async () => {
        resets += 1;
        const changed = await exportRows();
        const audits = await db.$count(auditLogs);
        if (cohort === "transitions") {
          expect(changed).not.toEqual(original);
          expect(audits).toBeGreaterThan(0);
        } else {
          expect(changed).toEqual(original);
          expect(audits).toBe(0);
        }
        await reset();
      },
    });
    expect(resets).toBe(1);
    expect(await exportRows()).toEqual(original);
    expect(await db.$count(auditLogs)).toBe(0);
    expect(statements.some(({ text }) => /^\s*explain\b/iu.test(text))).toBe(
      false,
    );
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
  },
);

test("a writing scheduled job cannot be measured without an explicit fixture reset", async () => {
  const db = fixture.db;
  const scenario = {
    type: "data-exports",
    rows: 30,
    cohort: "transitions",
  } as const;
  const reset = async () =>
    await seedDataExportScenario(asTestRaw<GatedTestDb>(db), scenario);
  await reset();
  const statements: CapturedStatement[] = [];
  const logged = drizzle({
    client: fixture.client,
    relations: databaseRelations,
    logger: {
      logQuery: (text, params) => {
        statements.push({ text, params });
      },
    },
  });
  expect(
    await rejectionOf(
      captureScheduledJobRun({
        database: asTestRaw<SchedulerDb>(logged),
        jobId: "dataExports.maintain.fiveMinute",
        task: MAINTAIN_DATA_EXPORTS_TASK,
        statements,
        dataExportMaintenance: {
          handoffPageSize: DATA_EXPORT_HANDOFF_PAGE_SIZE,
          enqueue: async () => QUEUE_REQUEUE_OUTCOME.REQUEUED,
        },
      }),
    ),
  ).toMatchObject({
    message: expect.stringContaining("explicit fixture reset"),
  });
  await reset();
});

class CaptureClientRefused extends TaggedError("CaptureClientRefused")<{
  message: string;
}> {}

test.each(["read-only", "resettable"] as const)(
  "the %s capture connection cannot silently execute unresettable writes",
  async (mode) => {
    const refusal = new CaptureClientRefused({
      message: "No PostgreSQL connection is opened by this unit test",
    });
    // The factory refuses before a client exists; no database facade or SQL is involved.
    const captured = await rejectionOf(
      measureScheduledJobRun({
        database: asTestRaw<GatedTestDb>(fixture.db),
        jobId: "dataExports.maintain.fiveMinute",
        task: MAINTAIN_DATA_EXPORTS_TASK,
        ...(mode === "resettable" ? { resetAfterCapture: async () => {} } : {}),
        openClient: (options) => {
          expect(options?.connection?.default_transaction_read_only).toBe(
            mode === "read-only" ? "on" : "off",
          );
          throw refusal;
        },
      }),
    );
    expect(captured).toBe(refusal);
  },
);

test.each([
  { text: "/* scope */ SET LOCAL ROLE stella", params: [] },
  { text: "-- scope\n ReSeT role", params: [] },
  { text: "SHOW role", params: [] },
  {
    text: "SELECT pg_catalog.set_config('role', $1, true)",
    params: ["stella"],
  },
  { text: "SELECT set_config($1, $2, true)", params: ["role", "stella"] },
])(
  "writing capture rejects unsupported scope command $text and still resets its fixture",
  async (statement) => {
    const db = fixture.db;
    const scenario = {
      type: "data-exports",
      rows: 6,
      cohort: "quiet",
    } as const;
    const reset = async () =>
      await seedDataExportScenario(asTestRaw<GatedTestDb>(db), scenario);
    await reset();
    const statements: CapturedStatement[] = [statement];
    const logged = drizzle({
      client: fixture.client,
      relations: databaseRelations,
      logger: {
        logQuery: (text, params) => {
          statements.push({ text, params });
        },
      },
    });
    let resets = 0;
    expect(
      await rejectionOf(
        captureScheduledJobRun({
          database: asTestRaw<SchedulerDb>(logged),
          jobId: "dataExports.maintain.fiveMinute",
          task: MAINTAIN_DATA_EXPORTS_TASK,
          statements,
          dataExportMaintenance: {
            handoffPageSize: DATA_EXPORT_HANDOFF_PAGE_SIZE,
            enqueue: async () => QUEUE_REQUEUE_OUTCOME.REQUEUED,
          },
          resetAfterCapture: async () => {
            resets += 1;
            await reset();
          },
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining("only global-owner scope"),
    });
    expect(resets).toBe(1);
  },
);

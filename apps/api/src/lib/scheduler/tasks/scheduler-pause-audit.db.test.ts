import { describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { schedulerJobs } from "@/api/db/schema";
import { logger } from "@/api/lib/observability/logger";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  auditSchedulerPauses,
  PAUSE_AUDIT_LOG_LIMIT,
} from "./scheduler-pause-audit";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const PAUSED_BY = "audit-test-operator";
const PAUSE_REASON = "Audit boundary test";

describe.skipIf(!enabled)("scheduler pause audit (postgres)", () => {
  test("logs exactly active pauses older than 24 hours or missing a start", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db, sql: client } = openClient();
      const prefix = `test.pause-audit.${Bun.randomUUIDv7()}`;
      const ids = {
        overdue: `${prefix}.overdue`,
        recent: `${prefix}.recent`,
        missingStart: `${prefix}.missing-start`,
        expired: `${prefix}.expired`,
        unpaused: `${prefix}.unpaused`,
      };
      const allIds = Object.values(ids);
      const logs = installRecordingLogger();
      try {
        await db.insert(schedulerJobs).values(
          allIds.map((id) => ({
            id,
            task: "scheduler.noop",
            description: "Pause audit test fixture",
            schedule: { type: "interval" as const, everyMs: 60_000 },
            nextRunAt: new Date(),
          })),
        );
        await client`UPDATE scheduler_jobs SET
            paused_by = ${PAUSED_BY}, pause_reason = ${PAUSE_REASON},
            paused_until = now() + interval '48 hours'
            WHERE id IN (${ids.overdue}, ${ids.recent}, ${ids.missingStart})`;
        await client`UPDATE scheduler_jobs SET paused_since = CASE
            WHEN id = ${ids.overdue} THEN now() - interval '24 hours 1 second'
            WHEN id = ${ids.recent} THEN now() - interval '23 hours 59 minutes 59 seconds'
            ELSE NULL END
            WHERE id IN (${ids.overdue}, ${ids.recent}, ${ids.missingStart})`;
        await client`UPDATE scheduler_jobs SET
            paused_by = ${PAUSED_BY}, pause_reason = ${PAUSE_REASON},
            paused_until = now() - interval '1 second'
            WHERE id = ${ids.expired}`;

        await auditSchedulerPauses(
          asTestRaw<SchedulerTaskContext>({ db, logger }),
        );

        const events = logs
          .at("ERROR")
          .filter(({ message }) => message === "scheduler.job.pause_overdue");
        expect(events).toHaveLength(2);
        expect(
          new Set(events.map(({ attributes }) => attributes?.["jobId"])),
        ).toEqual(new Set([ids.missingStart, ids.overdue]));
        expect(
          events.find(
            ({ attributes }) => attributes?.["jobId"] === ids.missingStart,
          )?.attributes?.["pausedSince"],
        ).toBe("null");
      } finally {
        logs.restore();
        await db.delete(schedulerJobs).where(inArray(schedulerJobs.id, allIds));
      }
    });
  });

  test("more overdue pauses than the limit report one overflow and no partial list", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db, sql: client } = openClient();
      const prefix = `test.pause-audit-limit.${Bun.randomUUIDv7()}`;
      const ids = Array.from(
        { length: PAUSE_AUDIT_LOG_LIMIT + 1 },
        (_, index) => `${prefix}.${String(index).padStart(3, "0")}`,
      );
      const logs = installRecordingLogger();
      try {
        await db.insert(schedulerJobs).values(
          ids.map((id) => ({
            id,
            task: "scheduler.noop",
            description: "Pause audit limit fixture",
            schedule: { type: "interval" as const, everyMs: 60_000 },
            nextRunAt: new Date(),
          })),
        );
        await client`UPDATE scheduler_jobs SET
            paused_by = ${PAUSED_BY}, pause_reason = ${PAUSE_REASON},
            paused_until = now() + interval '48 hours'
            WHERE id LIKE ${`${prefix}.%`}`;
        await client`UPDATE scheduler_jobs
            SET paused_since = now() - interval '2 days'
            WHERE id LIKE ${`${prefix}.%`}`;

        await auditSchedulerPauses(
          asTestRaw<SchedulerTaskContext>({ db, logger }),
        );

        const errors = logs.at("ERROR");
        expect(
          errors.filter(
            ({ message }) => message === "scheduler.job.pause_overdue",
          ),
        ).toHaveLength(0);
        const overflow = errors.filter(
          ({ message }) => message === "scheduler.job.pause_overdue_overflow",
        );
        expect(overflow).toHaveLength(1);
        expect(String(overflow.at(0)?.attributes?.["cap"])).toBe(
          String(PAUSE_AUDIT_LOG_LIMIT),
        );
      } finally {
        logs.restore();
        await db.delete(schedulerJobs).where(inArray(schedulerJobs.id, ids));
      }
    });
  });
});

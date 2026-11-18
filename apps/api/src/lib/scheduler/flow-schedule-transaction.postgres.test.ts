import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { deferred, settledWithin } from "@stll/test-kit";

import { schedulerJobs } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

import { FLOW_RUN_TASK, flowScheduleJobId } from "./flow-schedule-identity";
import { withFlowScheduleTransaction } from "./flow-schedule-transaction";
import { upsertSchedulerJob } from "./jobs";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!runPostgres || !databaseUrl) {
  describe.skip("flow schedule persistent fence", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("flow schedule persistent fence", () => {
    test("three reconcilers serialize across an initially absent scheduler row", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const observer = openClient();
        const a = openClient({ max: 1 });
        const b = openClient({ max: 1 });
        const c = openClient({ max: 1 });
        const definitionId = createSafeId<"flowDefinition">();
        const jobId = flowScheduleJobId(definitionId);
        const [aPid] = await a.sql<
          { pid: number }[]
        >`select pg_backend_pid() as pid`;
        const [bPid] = await b.sql<
          { pid: number }[]
        >`select pg_backend_pid() as pid`;
        const [cPid] = await c.sql<
          { pid: number }[]
        >`select pg_backend_pid() as pid`;
        if (!aPid || !bPid || !cPid) {
          panic("Three reconciliation sessions are required");
        }
        const inserted = deferred();
        const releaseA = deferred();
        const enteredB = deferred();
        const releaseB = deferred();
        const launched: Promise<void>[] = [];
        const definition = {
          id: jobId,
          task: FLOW_RUN_TASK,
          description: "First reconcile",
          schedule: { type: "daily", hour: 12, minute: 0, timeZone: "UTC" },
          payload: { definitionId },
        } satisfies Parameters<typeof upsertSchedulerJob>[0];
        try {
          const first = withFlowScheduleTransaction(
            { database: a.db, definitionId },
            async (tx) => {
              await upsertSchedulerJob(definition, tx);
              inserted.resolve();
              await releaseA.promise;
            },
          );
          launched.push(first);
          await settledWithin(inserted.promise, {
            description:
              "first reconciliation to insert the previously absent row",
          });
          const second = withFlowScheduleTransaction(
            { database: b.db, definitionId },
            async (tx) => {
              enteredB.resolve();
              await releaseB.promise;
              await upsertSchedulerJob(
                { ...definition, description: "Second reconcile" },
                tx,
              );
            },
          );
          launched.push(second);
          await waitForBlockedPid(observer.sql, {
            waitingPid: bPid.pid,
            holdingPid: aPid.pid,
          });
          releaseA.resolve();
          await settledWithin(enteredB.promise, {
            description: "second reconciliation to own the persistent fence",
          });
          const third = withFlowScheduleTransaction(
            { database: c.db, definitionId },
            async (tx) => {
              await upsertSchedulerJob(
                { ...definition, description: "Third reconcile" },
                tx,
              );
            },
          );
          launched.push(third);
          await waitForBlockedPid(observer.sql, {
            waitingPid: cPid.pid,
            holdingPid: bPid.pid,
          });
          releaseB.resolve();
          await Promise.all(launched);
          const row = await observer.db.query.schedulerJobs.findFirst({
            where: { id: { eq: jobId } },
          });
          expect(row).toMatchObject({
            description: "Third reconcile",
            task: FLOW_RUN_TASK,
            enabled: true,
          });
        } finally {
          releaseA.resolve();
          releaseB.resolve();
          await Promise.allSettled(launched);
          await observer.db
            .delete(schedulerJobs)
            .where(eq(schedulerJobs.id, jobId));
        }
      });
    });
  });
}

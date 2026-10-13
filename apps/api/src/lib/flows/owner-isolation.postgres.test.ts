import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  flowDefinitions,
  flowRuns,
  notifications,
  schedulerJobs,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { fileFlowRunCompletionNotice } from "@/api/lib/flows/flow-run-actor";
import { syncFlowScheduleTriggerInTransaction } from "@/api/lib/flows/sync-flow-schedule-trigger";
import {
  FLOW_RUN_TASK,
  flowScheduleJobId,
} from "@/api/lib/scheduler/tasks/flow-run";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = () =>
  process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL");

describe.skipIf(!enabled)(
  "flow owner organization isolation (postgres)",
  () => {
    test("schedule synchronization retains other organizations' source jobs", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const definitionId = createSafeId<"flowDefinition">();
        const jobId = flowScheduleJobId(definitionId);
        try {
          await db.insert(flowDefinitions).values({
            id: definitionId,
            organizationId: b.organizationId,
            createdByUserId: b.userId,
            name: "Scheduled fixture",
            steps: [],
            trigger: {
              type: "schedule",
              workspaceId: b.workspaceId,
              schedule: { frequency: "daily", hourUtc: 7 },
            },
          });
          await db.insert(schedulerJobs).values({
            id: jobId,
            task: FLOW_RUN_TASK,
            schedule: { type: "daily", hour: 7, minute: 0, timeZone: "UTC" },
            payload: { definitionId },
            nextRunAt: new Date("2040-01-01T07:00:00.000Z"),
          });
          const before = await db.query.schedulerJobs.findFirst({
            where: { id: { eq: jobId } },
          });
          expect(before).toBeDefined();
          await withAggregateTransaction(
            db,
            async (tx) =>
              await syncFlowScheduleTriggerInTransaction({
                tx,
                organizationId: a.organizationId,
                definitionId,
              }),
          );
          expect(
            await db.query.schedulerJobs.findFirst({
              where: { id: { eq: jobId } },
            }),
          ).toEqual(before);
        } finally {
          await db.delete(schedulerJobs).where(eq(schedulerJobs.id, jobId));
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test("completion notice admission retains other organizations' run state", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        try {
          await db
            .update(flowRuns)
            .set({ status: "completed" })
            .where(eq(flowRuns.id, b.runId));
          const read = async () => ({
            run: await db.query.flowRuns.findFirst({
              where: { id: { eq: b.runId } },
            }),
            notices: await db.query.notifications.findMany({
              where: { organizationId: { eq: b.organizationId } },
            }),
          });
          const before = await read();
          expect(before.run?.status).toBe("completed");
          await fileFlowRunCompletionNotice(
            {
              organizationId: a.organizationId,
              workspaceId: b.workspaceId,
              runId: b.runId,
              flowName: "Completed fixture",
              run: {
                definitionId: null,
                triggerSource: { type: "manual", userId: b.userId },
              },
            },
            db,
          );
          expect(await read()).toEqual(before);
          expect(
            await db.$count(
              notifications,
              eq(notifications.organizationId, a.organizationId),
            ),
          ).toBe(0);
        } finally {
          await b.cleanup();
          await a.cleanup();
        }
      });
    });
  },
);

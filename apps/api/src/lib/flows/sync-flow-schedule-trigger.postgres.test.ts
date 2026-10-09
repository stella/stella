import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import {
  featureEnrolments,
  flowDefinitions,
  schedulerJobs,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import {
  repairFlowScheduleTriggers,
  syncFlowScheduleTriggerInTransaction,
} from "@/api/lib/flows/sync-flow-schedule-trigger";
import {
  FLOW_RUN_TASK,
  flowScheduleJobId,
  flowRunPayloadSchema,
  flowRunPayloadMatchesSql,
} from "@/api/lib/scheduler/tasks/flow-run";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("flow schedule reconciliation (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("flow schedule reconciliation (postgres)", () => {
    test("repair ignores clean manual definitions and spends transactions only on schedule drift", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const f = await flowReviewGateFixture(db, { intermediate: false });
        const cases = [
          "missing",
          "changed",
          "stale manual",
          "disabled",
          "valid retained",
          "wrong payload",
        ] as const;
        const definitions = cases.map((type) => ({
          type,
          id: createSafeId<"flowDefinition">(),
        }));
        const manualIds = Array.from({ length: 9 }, () =>
          createSafeId<"flowDefinition">(),
        );
        const definitionIds = [
          ...manualIds,
          ...definitions.map((item) => item.id),
        ];
        const jobIds = definitions.map((item) => flowScheduleJobId(item.id));
        let transactions = 0;
        const database = {
          select: db.select.bind(db),
          transaction: async <Value>(
            run: (tx: Transaction) => Promise<Value>,
          ) => {
            transactions += 1;
            return await db.transaction(run);
          },
        };
        const principal = {
          organizationId: f.organizationId,
          userId: f.userId,
        };
        const pendingDueAt = "2040-01-01T07:00:00.000Z";
        try {
          await db.insert(flowDefinitions).values(
            manualIds.map((id) => ({
              id,
              organizationId: f.organizationId,
              createdByUserId: f.userId,
              name: "Manual flow",
              steps: [],
              trigger: { type: "manual" as const },
            })),
          );
          await repairFlowScheduleTriggers({
            database,
            principal,
            batchSize: 2,
          });
          expect(transactions).toBe(0);
          await db.insert(flowDefinitions).values(
            definitions.map(({ type, id }) => ({
              id,
              organizationId: f.organizationId,
              createdByUserId: f.userId,
              name: type,
              steps: [],
              enabled: type !== "disabled",
              trigger:
                type === "stale manual"
                  ? { type: "manual" as const }
                  : {
                      type: "schedule" as const,
                      workspaceId: f.workspaceId,
                      schedule: {
                        frequency: "weekly" as const,
                        hourUtc: 7,
                        dayOfWeek: 1,
                      },
                    },
            })),
          );
          await db.insert(schedulerJobs).values(
            definitions
              .filter((item) => item.type !== "missing")
              .map(({ type, id }) => ({
                id: flowScheduleJobId(id),
                task: FLOW_RUN_TASK,
                enabled: true,
                schedule: {
                  type: "daily" as const,
                  hour: type === "changed" ? 9 : 7,
                  minute: 0,
                  timeZone: "UTC",
                },
                nextRunAt: new Date(pendingDueAt),
                payload: {
                  definitionId:
                    type === "wrong payload"
                      ? createSafeId<"flowDefinition">()
                      : id,
                  ...(type === "valid retained"
                    ? { pendingDueAt, pendingClaimedAt: pendingDueAt }
                    : {}),
                },
              })),
          );
          await repairFlowScheduleTriggers({
            database,
            principal,
            batchSize: 2,
          });
          expect(transactions).toBe(5);
          const jobs = await db
            .select()
            .from(schedulerJobs)
            .where(inArray(schedulerJobs.id, jobIds));
          for (const definition of definitions) {
            const job = jobs.find(
              (item) => item.id === flowScheduleJobId(definition.id),
            );
            if (definition.type === "stale manual") {
              expect(job).toBeUndefined();
              continue;
            }
            expect(job?.schedule).toEqual({
              type: "daily",
              hour: 7,
              minute: 0,
              timeZone: "UTC",
            });
            expect(job?.enabled).toBe(definition.type !== "disabled");
            expect(job?.payload?.["definitionId"]).toBe(definition.id);
            if (definition.type === "valid retained") {
              expect(job?.payload).toEqual({
                definitionId: definition.id,
                pendingDueAt,
                pendingClaimedAt: pendingDueAt,
              });
            }
          }
          transactions = 0;
          await repairFlowScheduleTriggers({
            database,
            principal,
            batchSize: 2,
          });
          expect(transactions).toBe(0);
          await db
            .delete(featureEnrolments)
            .where(
              and(
                eq(featureEnrolments.organizationId, f.organizationId),
                eq(featureEnrolments.userId, f.userId),
                eq(featureEnrolments.featureId, "flows"),
              ),
            );
          await repairFlowScheduleTriggers({
            database,
            principal,
            batchSize: 2,
          });
          const missing =
            definitions.find((item) => item.type === "missing") ??
            panic("Missing schedule fixture");
          await db
            .delete(schedulerJobs)
            .where(eq(schedulerJobs.id, flowScheduleJobId(missing.id)));
          transactions = 0;
          await repairFlowScheduleTriggers({
            database,
            principal,
            batchSize: 2,
          });
          expect(transactions).toBe(0);
        } finally {
          await db
            .delete(schedulerJobs)
            .where(inArray(schedulerJobs.id, jobIds));
          await db
            .delete(flowDefinitions)
            .where(inArray(flowDefinitions.id, definitionIds));
          await f.cleanup();
        }
      });
    });

    test("payload drift SQL matches the task schema and source identity", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const definitionId = createSafeId<"flowDefinition">();
        const payloads = [
          { definitionId },
          { definitionId, pendingDueAt: "2040-01-01T07:00:00.000Z" },
          { definitionId, pendingClaimedAt: "2040-01-01 07:00:00+01" },
          {
            definitionId,
            pendingDueAt: "2040-01-01T07:00:00.123456789Z",
            pendingClaimedAt: "2040-01-01T07:00:00Z",
          },
          { definitionId, pendingDueAt: "invalid" },
          { definitionId, pendingDueAt: null },
          { definitionId, pendingClaimedAt: 42 },
          { definitionId, extra: true },
          { definitionId: createSafeId<"flowDefinition">() },
          null,
          "scalar",
          42,
          [],
        ];
        for (const payload of payloads) {
          // db-await-in-loop: compare the finite schema boundary matrix with actual PostgreSQL matching.
          const rows = await db
            .select({
              matches: flowRunPayloadMatchesSql({
                payload: sql`${JSON.stringify(payload)}::text::jsonb`,
                definitionId: sql`${definitionId}::text`,
              }),
            })
            .from(sql`(VALUES (true)) AS payload_fixture(value)`);
          const parsed = v.safeParse(flowRunPayloadSchema, payload);
          expect(rows.at(0)?.matches).toBe(
            parsed.success && parsed.output.definitionId === definitionId,
          );
        }
      });
    });

    test("opt-out retains the due slot, regrant preserves it, and schedule changes replace it", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const f = await flowReviewGateFixture(db, { intermediate: false });
        const definitionId = createSafeId<"flowDefinition">();
        const jobId = flowScheduleJobId(definitionId);
        const dueAt = "2040-01-01T07:00:00.000Z";
        try {
          await withAggregateTransaction(db, async (tx) => {
            await lockFeatureRecoveryAdmission({
              tx,
              organizationId: f.organizationId,
              featureId: "flows",
            });
            await tx.insert(flowDefinitions).values({
              id: definitionId,
              organizationId: f.organizationId,
              createdByUserId: f.userId,
              name: "Scheduled flow",
              steps: [
                { kind: "review-gate", name: "Review", instructions: "Review" },
              ],
              trigger: {
                type: "schedule",
                workspaceId: f.workspaceId,
                schedule: { frequency: "daily", hourUtc: 7 },
              },
            });
            await syncFlowScheduleTriggerInTransaction({
              tx,
              organizationId: f.organizationId,
              definitionId,
            });
          });
          await db
            .update(schedulerJobs)
            .set({
              payload: {
                definitionId,
                pendingDueAt: dueAt,
                pendingClaimedAt: dueAt,
              },
            })
            .where(eq(schedulerJobs.id, jobId));
          await withAggregateTransaction(db, async (tx) => {
            await lockFeatureRecoveryAdmission({
              tx,
              organizationId: f.organizationId,
              featureId: "flows",
            });
            await tx
              .delete(featureEnrolments)
              .where(
                and(
                  eq(featureEnrolments.organizationId, f.organizationId),
                  eq(featureEnrolments.userId, f.userId),
                  eq(featureEnrolments.featureId, "flows"),
                ),
              );
            await syncFlowScheduleTriggerInTransaction({
              tx,
              organizationId: f.organizationId,
              definitionId,
            });
          });
          const parked = await db.query.schedulerJobs.findFirst({
            where: { id: { eq: jobId } },
          });
          expect(parked?.enabled).toBe(false);
          expect(parked?.payload?.["pendingDueAt"]).toBe(dueAt);
          await db.insert(featureEnrolments).values({
            organizationId: f.organizationId,
            userId: f.userId,
            featureId: "flows",
          });
          await repairFlowScheduleTriggers({
            database: db,
            principal: { organizationId: f.organizationId, userId: f.userId },
            batchSize: 1,
          });
          const resumed = await db.query.schedulerJobs.findFirst({
            where: { id: { eq: jobId } },
          });
          expect(resumed?.enabled).toBe(true);
          expect(resumed?.payload?.["pendingDueAt"]).toBe(dueAt);
          await withAggregateTransaction(db, async (tx) => {
            await lockFeatureRecoveryAdmission({
              tx,
              organizationId: f.organizationId,
              featureId: "flows",
            });
            await tx
              .update(flowDefinitions)
              .set({
                trigger: {
                  type: "schedule",
                  workspaceId: f.workspaceId,
                  schedule: { frequency: "daily", hourUtc: 8 },
                },
              })
              .where(eq(flowDefinitions.id, definitionId));
            await syncFlowScheduleTriggerInTransaction({
              tx,
              organizationId: f.organizationId,
              definitionId,
            });
          });
          const changed = await db.query.schedulerJobs.findFirst({
            where: { id: { eq: jobId } },
          });
          expect(changed?.payload).toEqual({ definitionId });
          expect(changed?.schedule).toEqual({
            type: "daily",
            hour: 8,
            minute: 0,
            timeZone: "UTC",
          });
          await withAggregateTransaction(db, async (tx) => {
            await lockFeatureRecoveryAdmission({
              tx,
              organizationId: f.organizationId,
              featureId: "flows",
            });
            await tx
              .delete(flowDefinitions)
              .where(eq(flowDefinitions.id, definitionId));
            await syncFlowScheduleTriggerInTransaction({
              tx,
              organizationId: f.organizationId,
              definitionId,
            });
          });
          expect(
            await db.$count(schedulerJobs, eq(schedulerJobs.id, jobId)),
          ).toBe(0);
        } finally {
          await db.delete(schedulerJobs).where(eq(schedulerJobs.id, jobId));
          await f.cleanup();
        }
      });
    });

    test("repair recovers every missing schedule across bounded pages without creating ungranted jobs", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const f = await flowReviewGateFixture(db, { intermediate: false });
        const definitionIds = Array.from({ length: 3 }, () =>
          createSafeId<"flowDefinition">(),
        );
        const jobIds = definitionIds.map(flowScheduleJobId);
        try {
          await db.insert(flowDefinitions).values(
            definitionIds.map((id) => ({
              id,
              organizationId: f.organizationId,
              createdByUserId: f.userId,
              name: "Recovered schedule",
              steps: [
                {
                  kind: "review-gate" as const,
                  name: "Review",
                  instructions: "Review",
                },
              ],
              trigger: {
                type: "schedule" as const,
                workspaceId: f.workspaceId,
                schedule: { frequency: "daily" as const, hourUtc: 7 },
              },
            })),
          );
          await db
            .delete(featureEnrolments)
            .where(
              and(
                eq(featureEnrolments.organizationId, f.organizationId),
                eq(featureEnrolments.userId, f.userId),
                eq(featureEnrolments.featureId, "flows"),
              ),
            );
          await repairFlowScheduleTriggers({
            database: db,
            principal: { organizationId: f.organizationId, userId: f.userId },
            batchSize: 2,
          });
          expect(
            await db.$count(schedulerJobs, inArray(schedulerJobs.id, jobIds)),
          ).toBe(0);
          await db.insert(featureEnrolments).values({
            organizationId: f.organizationId,
            userId: f.userId,
            featureId: "flows",
          });
          await repairFlowScheduleTriggers({
            database: db,
            principal: { organizationId: f.organizationId, userId: f.userId },
            batchSize: 2,
          });
          expect(
            await db.$count(
              schedulerJobs,
              and(
                inArray(schedulerJobs.id, jobIds),
                eq(schedulerJobs.enabled, true),
              ),
            ),
          ).toBe(3);
          const first =
            definitionIds.at(0) ?? panic("Missing schedule fixture");
          await withAggregateTransaction(db, async (tx) => {
            await lockFeatureRecoveryAdmission({
              tx,
              organizationId: f.organizationId,
              featureId: "flows",
            });
            await tx
              .update(flowDefinitions)
              .set({ trigger: { type: "manual" } })
              .where(eq(flowDefinitions.id, first));
            await syncFlowScheduleTriggerInTransaction({
              tx,
              organizationId: f.organizationId,
              definitionId: first,
            });
          });
          expect(
            await db.$count(
              schedulerJobs,
              eq(schedulerJobs.id, flowScheduleJobId(first)),
            ),
          ).toBe(0);
          await db.insert(schedulerJobs).values({
            id: flowScheduleJobId(first),
            task: FLOW_RUN_TASK,
            description: "Orphaned schedule",
            schedule: { type: "daily", hour: 7, minute: 0, timeZone: "UTC" },
            nextRunAt: new Date("2040-01-01T07:00:00.000Z"),
            payload: { definitionId: first },
            enabled: false,
          });
          await db
            .update(schedulerJobs)
            .set({ enabled: false })
            .where(inArray(schedulerJobs.id, jobIds));
          await db
            .delete(flowDefinitions)
            .where(inArray(flowDefinitions.id, definitionIds));
          await repairFlowScheduleTriggers({ database: db, batchSize: 2 });
          expect(
            await db.$count(schedulerJobs, inArray(schedulerJobs.id, jobIds)),
          ).toBe(0);
        } finally {
          await db
            .delete(schedulerJobs)
            .where(inArray(schedulerJobs.id, jobIds));
          await f.cleanup();
        }
      });
    });
  });
}

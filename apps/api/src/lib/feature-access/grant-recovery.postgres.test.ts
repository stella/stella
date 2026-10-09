import { panic, Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";
import { and, eq, getTableName, sql } from "drizzle-orm";

import { MEMBER_REMOVAL_BUSY_CODE } from "@stll/api-contract";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member } from "@/api/db/auth-schema";
import {
  featureEnrolments,
  flowDefinitions,
  flowUploadTriggerIntents,
  notifications,
  pendingScoutEmissions,
  schedulerJobs,
  signals,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { resumeFlowsAfterGrant } from "@/api/lib/flows/grant-recovery";
import { removeOrganizationMemberInTransaction } from "@/api/lib/member-assignment-offboarding-owner";
import { flowScheduleJobId } from "@/api/lib/scheduler/tasks/flow-run";
import { resumeSignalsAfterGrant } from "@/api/lib/signals/grant-recovery";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  flowReviewGateFixture,
  waitForBlockedPid,
} from "@/api/tests/helpers/flow-review-gate";
import { createTestState } from "@/api/tests/helpers/test-state";

const testState = createTestState({ file: import.meta.path, config: env });

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("grant recovery admission (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("grant recovery admission (postgres)", () => {
    test("a recovery facade waiting on admission observes the committed revoke", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const writer = openClient({ max: 1 });
        const observer = openClient({ max: 1 });
        const sourceQueries: string[] = [];
        const recovery = openClient({
          max: 1,
          logger: {
            logQuery: (query) => {
              if (query.includes(getTableName(flowUploadTriggerIntents))) {
                sourceQueries.push(query);
              }
            },
          },
        });
        const f = await flowReviewGateFixture(writer.db, {
          intermediate: false,
          initialRunStatus: "pending",
        });
        const previousFlag = env.FEATURE_FLOWS;
        const restoreRuntime = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        testState.setConfig("FEATURE_FLOWS", true);
        const enqueueStep = mock(async () => {});
        const writerPid = Number(
          (await writer.db.execute(sql`SELECT pg_backend_pid() AS pid`)).at(
            0,
          )?.["pid"],
        );
        const recoveryPid = Number(
          (await recovery.db.execute(sql`SELECT pg_backend_pid() AS pid`)).at(
            0,
          )?.["pid"],
        );
        const definitionId = createSafeId<"flowDefinition">();
        await writer.db.insert(flowDefinitions).values({
          id: definitionId,
          organizationId: f.organizationId,
          createdByUserId: f.userId,
          name: "Retained source",
          steps: [
            { kind: "review-gate", name: "Review", instructions: "Review" },
          ],
          trigger: {
            type: "file-upload",
            workspaceIds: null,
            fileExtensions: null,
          },
        });
        await writer.db.insert(flowUploadTriggerIntents).values({
          definitionId,
          entityId: f.taskEntityId,
          organizationId: f.organizationId,
          workspaceId: f.workspaceId,
          status: "awaiting_grant",
        });
        const retained = async () => ({
          flow: await f.read(),
          receipt: (
            await writer.db
              .select()
              .from(flowUploadTriggerIntents)
              .where(eq(flowUploadTriggerIntents.definitionId, definitionId))
              .limit(1)
          ).at(0),
        });
        const before = await retained();
        const ready = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const revoke = withAggregateTransaction(writer.db, async (tx) => {
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
          ready.resolve(undefined);
          await release.promise;
        });
        let resumed: ReturnType<typeof resumeFlowsAfterGrant> | undefined;
        try {
          await Promise.race([ready.promise, revoke]);
          resumed = resumeFlowsAfterGrant(
            { organizationId: f.organizationId, userId: f.userId },
            { database: recovery.db, enqueueStep },
          );
          await waitForBlockedPid(observer.sql, {
            waitingPid: recoveryPid,
            holdingPid: writerPid,
          });
          release.resolve(undefined);
          await revoke;
          await resumed;
          expect(await retained()).toEqual(before);
          expect(enqueueStep).not.toHaveBeenCalled();
          // Refused admission ends recovery before retained sources are read.
          expect(sourceQueries).toEqual([]);
        } finally {
          release.resolve(undefined);
          await Promise.allSettled(resumed ? [revoke, resumed] : [revoke]);
          await f.cleanup();
          testState.setConfig("FEATURE_FLOWS", previousFlag);
          restoreRuntime();
        }
      });
    });

    test("member removal refuses while a recovery facade holds admission", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const writer = openClient({ max: 1 });
        const recovery = openClient({ max: 1 });
        const removal = openClient({ max: 1 });
        const observer = openClient({ max: 1 });
        const f = await flowReviewGateFixture(writer.db, {
          intermediate: false,
          initialRunStatus: "pending",
        });
        const membership = await writer.db.query.member.findFirst({
          where: {
            organizationId: { eq: f.organizationId },
            userId: { eq: f.userId },
          },
        });
        if (!membership) {
          return panic("Missing recovery principal membership");
        }
        const previousFlag = env.FEATURE_FLOWS;
        const restoreRuntime = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        testState.setConfig("FEATURE_FLOWS", true);
        const enqueueStep = mock(async () => {});
        const writerPid = Number(
          (await writer.db.execute(sql`SELECT pg_backend_pid() AS pid`)).at(
            0,
          )?.["pid"],
        );
        const recoveryPid = Number(
          (await recovery.db.execute(sql`SELECT pg_backend_pid() AS pid`)).at(
            0,
          )?.["pid"],
        );
        const ready = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const held = withAggregateTransaction(writer.db, async (tx) => {
          // Hold the grant read after the facade acquires its admission lock.
          await tx.execute(
            sql`LOCK TABLE ${featureEnrolments} IN ACCESS EXCLUSIVE MODE`,
          );
          ready.resolve(undefined);
          await release.promise;
        });
        let resumed: ReturnType<typeof resumeFlowsAfterGrant> | undefined;
        try {
          await Promise.race([ready.promise, held]);
          resumed = resumeFlowsAfterGrant(
            { organizationId: f.organizationId, userId: f.userId },
            { database: recovery.db, enqueueStep },
          );
          await waitForBlockedPid(observer.sql, {
            waitingPid: recoveryPid,
            holdingPid: writerPid,
          });
          const removed = await Result.tryPromise(
            async () =>
              await withAggregateTransaction(removal.db, async (tx) => {
                await removeOrganizationMemberInTransaction(tx, {
                  organizationId: f.organizationId,
                  memberId: membership.id,
                  userId: f.userId,
                  actorUserId: f.userId,
                });
              }),
          );
          expect(removed).toMatchObject({
            status: "error",
            error: { cause: { status: 409, code: MEMBER_REMOVAL_BUSY_CODE } },
          });
          expect(
            await removal.db.query.member.findFirst({
              where: { id: { eq: membership.id } },
            }),
          ).toEqual(membership);
          release.resolve(undefined);
          await held;
          await resumed;
        } finally {
          release.resolve(undefined);
          await Promise.allSettled(resumed ? [held, resumed] : [held]);
          await f.cleanup();
          testState.setConfig("FEATURE_FLOWS", previousFlag);
          restoreRuntime();
        }
      });
    });

    test.each(["revoked-grant", "removed-membership"] as const)(
      "%s: both recovery facades preserve retained sources without effects",
      async (refusal) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const f = await flowReviewGateFixture(db, {
            intermediate: false,
            initialRunStatus: "pending",
          });
          const previousFlows = env.FEATURE_FLOWS;
          const previousSignals = env.FEATURE_SIGNALS;
          const restoreRuntime = setRuntimeModeForTesting({
            mode: RUNTIME_MODE.strict,
          });
          testState.setConfig("FEATURE_FLOWS", true);
          testState.setConfig("FEATURE_SIGNALS", true);
          const definitionId = createSafeId<"flowDefinition">();
          const enqueueStep = mock(async () => {});
          try {
            await db.insert(featureEnrolments).values({
              organizationId: f.organizationId,
              userId: f.userId,
              featureId: "signals",
            });
            await db.insert(flowDefinitions).values({
              id: definitionId,
              organizationId: f.organizationId,
              createdByUserId: f.userId,
              name: "Retained source",
              steps: [
                { kind: "review-gate", name: "Review", instructions: "Review" },
              ],
              trigger: {
                type: "file-upload",
                workspaceIds: null,
                fileExtensions: null,
              },
            });
            await db.insert(flowUploadTriggerIntents).values({
              definitionId,
              entityId: f.taskEntityId,
              organizationId: f.organizationId,
              workspaceId: f.workspaceId,
              status: "awaiting_grant",
            });
            await db.insert(pendingScoutEmissions).values({
              organizationId: f.organizationId,
              workspaceId: f.workspaceId,
              sourceKind: "infosoud-hearing",
              sourceId: f.taskEntityId,
              status: "awaiting_grant",
            });
            // Prove this is a live, granted principal before the committed refusal.
            await withAggregateTransaction(db, async (tx) => {
              expect(
                await isBackgroundFeatureEnabled({
                  tx,
                  organizationId: f.organizationId,
                  userId: f.userId,
                  featureId: "flows",
                }),
              ).toBe(true);
              expect(
                await isBackgroundFeatureEnabled({
                  tx,
                  organizationId: f.organizationId,
                  userId: f.userId,
                  featureId: "signals",
                }),
              ).toBe(true);
            });
            const retained = async () => ({
              flow: await f.read(),
              upload: (
                await db
                  .select()
                  .from(flowUploadTriggerIntents)
                  .where(
                    eq(flowUploadTriggerIntents.definitionId, definitionId),
                  )
                  .limit(1)
              ).at(0),
              scout: (
                await db
                  .select()
                  .from(pendingScoutEmissions)
                  .where(
                    eq(pendingScoutEmissions.organizationId, f.organizationId),
                  )
                  .limit(1)
              ).at(0),
            });
            const before = await retained();
            await withAggregateTransaction(db, async (tx) => {
              await lockFeatureRecoveryAdmission({
                tx,
                organizationId: f.organizationId,
                featureId: "flows",
              });
              await lockFeatureRecoveryAdmission({
                tx,
                organizationId: f.organizationId,
                featureId: "signals",
              });
              switch (refusal) {
                case "revoked-grant":
                  await tx
                    .delete(featureEnrolments)
                    .where(
                      and(
                        eq(featureEnrolments.organizationId, f.organizationId),
                        eq(featureEnrolments.userId, f.userId),
                      ),
                    );
                  break;
                case "removed-membership":
                  await tx
                    .delete(member)
                    .where(
                      and(
                        eq(member.organizationId, f.organizationId),
                        eq(member.userId, f.userId),
                      ),
                    );
                  break;
                default:
                  refusal satisfies never;
              }
            });
            await resumeFlowsAfterGrant(
              { organizationId: f.organizationId, userId: f.userId },
              { database: db, enqueueStep },
            );
            await resumeSignalsAfterGrant(
              { organizationId: f.organizationId, userId: f.userId },
              { database: db },
            );
            expect(await retained()).toEqual(before);
            expect(enqueueStep).not.toHaveBeenCalled();
            expect(
              await db
                .select({ id: signals.id })
                .from(signals)
                .where(eq(signals.organizationId, f.organizationId)),
            ).toEqual([]);
            expect(
              await db
                .select({ id: notifications.id })
                .from(notifications)
                .where(eq(notifications.organizationId, f.organizationId)),
            ).toEqual([]);
            expect(
              await db.query.schedulerJobs.findFirst({
                where: { id: { eq: flowScheduleJobId(definitionId) } },
              }),
            ).toBeUndefined();
          } finally {
            await db
              .delete(schedulerJobs)
              .where(eq(schedulerJobs.id, flowScheduleJobId(definitionId)));
            await f.cleanup();
            testState.setConfig("FEATURE_FLOWS", previousFlows);
            testState.setConfig("FEATURE_SIGNALS", previousSignals);
            restoreRuntime();
          }
        });
      },
    );
  });
}

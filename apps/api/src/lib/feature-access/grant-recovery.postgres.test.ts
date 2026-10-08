import { describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";

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
import { flowScheduleJobId } from "@/api/lib/scheduler/tasks/flow-run";
import { resumeSignalsAfterGrant } from "@/api/lib/signals/grant-recovery";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("grant recovery admission (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("grant recovery admission (postgres)", () => {
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
          env.FEATURE_FLOWS = true;
          env.FEATURE_SIGNALS = true;
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
              upload: await db.query.flowUploadTriggerIntents.findFirst({
                where: { definitionId: { eq: definitionId } },
              }),
              scout: await db.query.pendingScoutEmissions.findFirst({
                where: { organizationId: { eq: f.organizationId } },
              }),
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
            env.FEATURE_FLOWS = previousFlows;
            env.FEATURE_SIGNALS = previousSignals;
            restoreRuntime();
          }
        });
      },
    );
  });
}

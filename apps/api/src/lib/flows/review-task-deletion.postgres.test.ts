import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { featureEnrolments, flowRuns, flowRunSteps } from "@/api/db/schema";
import { env } from "@/api/env";
import { deleteEntitiesHandler } from "@/api/handlers/entities/delete";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl || process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true") {
  describe.skip("review task deletion admission", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  test("refuses active reviews, hides retained tasks on opt-out, and permits admitted terminal history deletion", async () => {
    const previousFlag = env.FEATURE_FLOWS;
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    env.FEATURE_FLOWS = true;
    try {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await flowReviewGateFixture(db, {
          intermediate: false,
        });
        try {
          const remove = async () =>
            await Result.gen(async function* () {
              return yield* deleteEntitiesHandler({
                safeDb: fixture.safeDb(db),
                organizationId: fixture.organizationId,
                workspaceId: fixture.workspaceId,
                userId: fixture.userId,
                recordAuditEvent: fixture.recordAuditEvent,
                body: { entityIds: [fixture.taskEntityId] },
              });
            });
          const active = await remove();
          expect(active.isErr()).toBe(true);
          if (active.isErr()) {
            expect(active.error).toMatchObject({ status: 409 });
          }
          expect((await fixture.read()).steps.at(0)?.reviewTaskEntityId).toBe(
            fixture.taskEntityId,
          );
          await db.transaction(async (tx) => {
            await lockFeatureRecoveryAdmission({
              tx,
              organizationId: fixture.organizationId,
              featureId: "flows",
            });
            await tx
              .delete(featureEnrolments)
              .where(
                and(
                  eq(featureEnrolments.organizationId, fixture.organizationId),
                  eq(featureEnrolments.userId, fixture.userId),
                  eq(featureEnrolments.featureId, "flows"),
                ),
              );
          });
          const hidden = await remove();
          expect(hidden.isErr()).toBe(true);
          if (hidden.isErr()) {
            expect(hidden.error).toMatchObject({
              status: 404,
              message: "Not found",
            });
          }
          await db.transaction(async (tx) => {
            await tx
              .update(flowRuns)
              .set({ status: "completed" })
              .where(eq(flowRuns.id, fixture.runId));
            await tx
              .update(flowRunSteps)
              .set({ status: "completed" })
              .where(eq(flowRunSteps.runId, fixture.runId));
          });
          const hiddenHistory = await remove();
          expect(hiddenHistory.isErr()).toBe(true);
          if (hiddenHistory.isErr()) {
            expect(hiddenHistory.error).toMatchObject({ status: 404 });
          }
          await db.transaction(async (tx) => {
            await lockFeatureRecoveryAdmission({
              tx,
              organizationId: fixture.organizationId,
              featureId: "flows",
            });
            await tx.insert(featureEnrolments).values({
              organizationId: fixture.organizationId,
              userId: fixture.userId,
              featureId: "flows",
            });
          });
          expect((await remove()).isOk()).toBe(true);
          expect(
            await db.query.entities.findFirst({
              where: { id: { eq: fixture.taskEntityId } },
            }),
          ).toBeUndefined();
          expect(
            (await fixture.read()).steps.at(0)?.reviewTaskEntityId,
          ).toBeNull();
        } finally {
          await fixture.cleanup();
        }
      });
    } finally {
      env.FEATURE_FLOWS = previousFlag;
      restore();
    }
  });
}

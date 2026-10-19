import { Result } from "better-result";
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import type { SafeDb } from "@/api/db/safe-db";
import { flowRunSteps } from "@/api/db/schema";
import { env } from "@/api/env";
import { deleteEntitiesHandler } from "@/api/handlers/entities/delete";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

const testState = createTestState({ file: import.meta.path, config: env });

test("retains a task linked to an active review before the deletion fence", async () => {
  const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
  testState.setConfig("FEATURE_FLOWS", true);
  const database = asTestRaw<GatedTestDb>(await getTestDb());
  try {
    const fixture = await flowReviewGateFixture(database, {
      intermediate: false,
    });
    try {
      await database
        .update(flowRunSteps)
        .set({ reviewTaskEntityId: null })
        .where(eq(flowRunSteps.runId, fixture.runId));
      expect((await fixture.read()).steps.at(0)?.reviewTaskEntityId).toBeNull();
      let linked = false;
      const baseSafeDb = fixture.safeDb(database);
      // Schedule the real link write when deletion starts acquiring its fences,
      // after admission has been read; the link must still keep the task.
      const safeDb: SafeDb = async (work, retry) =>
        await baseSafeDb(
          async (tx) =>
            await work(
              new Proxy(tx, {
                get: (target, property) => {
                  if (property === "execute") {
                    return async (query: SQL) => {
                      if (!linked) {
                        await target
                          .update(flowRunSteps)
                          .set({ reviewTaskEntityId: fixture.taskEntityId })
                          .where(eq(flowRunSteps.runId, fixture.runId));
                        linked = true;
                      }
                      return await target.execute(query);
                    };
                  }
                  const value: unknown = Reflect.get(target, property, target);
                  return value;
                },
              }),
            ),
          retry,
        );
      const removed = await Result.gen(async function* () {
        return yield* deleteEntitiesHandler({
          safeDb,
          organizationId: fixture.organizationId,
          workspaceId: fixture.workspaceId,
          userId: fixture.userId,
          recordAuditEvent: fixture.recordAuditEvent,
          enqueueCleanup: async () => undefined,
          body: { entityIds: [fixture.taskEntityId] },
        });
      });
      expect(linked).toBe(true);
      expect(removed.isErr()).toBe(true);
      if (removed.isErr()) {
        expect(removed.error).toMatchObject({
          status: 409,
          message: "An active workflow review task cannot be deleted",
        });
      }
      const retained = await fixture.read();
      expect(retained.task?.id).toBe(fixture.taskEntityId);
      expect(retained.run?.status).toBe("awaiting_review");
      expect(retained.steps.at(0)?.reviewTaskEntityId).toBe(
        fixture.taskEntityId,
      );
    } finally {
      await fixture.cleanup();
    }
  } finally {
    await releaseTestDb();
    restore();
  }
});

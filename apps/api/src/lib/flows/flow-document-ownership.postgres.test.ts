import { type InferOk, panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import {
  entities,
  featureEnrolments,
  flowRuns,
  flowRunSteps,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  createEntityFromBuffer,
  CreateEntityFromBufferResult,
} from "@/api/lib/entities/create-from-buffer";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { executeFlowStep, FlowStepError } from "@/api/lib/flows/flow-executor";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("flow document ownership (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("flow document ownership (postgres)", () => {
    for (const winner of [
      "cancel",
      "document",
      "duplicate",
      "cleanup-failure",
      "revoke",
    ] as const) {
      test(`${winner} wins: artifacts and persisted outputs converge atomically`, async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const worker = openClient();
          const duplicate = openClient();
          const cancellation = openClient();
          const f = await flowReviewGateFixture(db, {
            intermediate: true,
            initialRunStatus: "pending",
          });
          const release = Promise.withResolvers<undefined>();
          const reached = Promise.withResolvers<undefined>();
          const attemptedIds: ReturnType<typeof createSafeId<"entity">>[] = [];
          const launched: Promise<unknown>[] = [];
          let creations = 0;
          const cleanupFailure = new HandlerError({
            status: 500,
            message: "Document cleanup failed",
          });
          try {
            await db
              .update(flowRuns)
              .set({
                status: "pending",
                currentStepIndex: 1,
                definitionSnapshot: {
                  name: "Document flow",
                  steps: [
                    {
                      kind: "ai",
                      name: "Draft",
                      prompt: "Draft",
                      includeDocuments: false,
                    },
                    {
                      kind: "create-document",
                      name: "Save",
                      documentTitle: "Generated",
                    },
                  ],
                },
              })
              .where(eq(flowRuns.id, f.runId));
            await db
              .update(flowRunSteps)
              .set({ status: "running" })
              .where(eq(flowRunSteps.reviewTaskEntityId, f.taskEntityId));
            await db
              .update(flowRunSteps)
              .set({
                kind: "ai",
                status: "completed",
                reviewTaskEntityId: null,
                output: { kind: "ai", markdown: "# Generated document" },
              })
              .where(eq(flowRunSteps.reviewTaskEntityId, f.taskEntityId));
            const pending = await db.query.flowRunSteps.findFirst({
              where: { runId: { eq: f.runId }, index: { eq: 1 } },
            });
            if (!pending) {
              panic("Expected pending document step");
            }
            await db
              .update(flowRunSteps)
              .set({ kind: "create-document" })
              .where(eq(flowRunSteps.id, pending.id));

            const createEntity: typeof createEntityFromBuffer = async ({
              scopedDb,
              workspaceId,
              beforeCreate,
              afterCreate,
              fileName,
            }) => {
              creations += 1;
              if (winner !== "duplicate" || creations === 2) {
                reached.resolve(undefined);
              }
              await release.promise;
              const result = {
                entityId: createSafeId<"entity">(),
                entityVersionId: createSafeId<"entityVersion">(),
                fieldId: createSafeId<"field">(),
                fileName,
                renamed: false,
              } satisfies InferOk<CreateEntityFromBufferResult>;
              attemptedIds.push(result.entityId);
              // Model the real creator's transaction and lock order; the
              // external upload is the barrier above, outside the transaction.
              const written = await Result.tryPromise({
                try: async () =>
                  await scopedDb(async (tx) => {
                    await beforeCreate?.(tx);
                    await lockWorkspacesForEntityCap(tx, [workspaceId]);
                    await tx.insert(entities).values({
                      id: result.entityId,
                      workspaceId,
                      name: fileName,
                      kind: "document",
                    });
                    await afterCreate?.(tx, result);
                  }),
                catch: (cause) => cause,
              });
              if (written.isErr()) {
                throw winner === "cleanup-failure"
                  ? cleanupFailure
                  : written.error;
              }
              return Result.ok(result);
            };
            const start = async (connection: typeof worker) =>
              await executeFlowStep(
                { runId: f.runId, stepIndex: 1 },
                new AbortController().signal,
                {
                  admission: testModelAdmission(f.organizationId),
                  database: connection.db,
                  makeScopedDb: () =>
                    createScopedDb(
                      markRlsDatabase(connection.db),
                      [f.workspaceId],
                      f.organizationId,
                      f.userId,
                    ),
                  makeSafeDb: () => f.safeDb(connection.db),
                  broadcastUpdate: () => undefined,
                  enqueueStep: async () => undefined,
                  createEntity,
                },
              );
            const running = start(worker);
            launched.push(running);
            if (winner === "duplicate") {
              launched.push(start(duplicate));
            }
            await Promise.race([
              reached.promise,
              running.then(() =>
                panic("Document worker missed its creation barrier"),
              ),
            ]);
            expect(creations).toBe(winner === "duplicate" ? 2 : 1);
            if (winner === "cancel" || winner === "cleanup-failure") {
              const cancelled = await f.act(
                f.safeDb(cancellation.db),
                "cancel",
              );
              expect(cancelled.isOk()).toBe(true);
            }
            if (winner === "revoke") {
              await cancellation.db.transaction(async (tx) => {
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
              });
            }
            release.resolve(undefined);
            if (winner === "cleanup-failure") {
              const failure = await running.then(
                () => panic("Document cleanup failure unexpectedly succeeded"),
                (error: unknown) => error,
              );
              expect(failure).toBeInstanceOf(FlowStepError);
              expect(failure).toMatchObject({
                cause: cleanupFailure,
              });
            } else if (winner === "revoke") {
              expect(await running).toEqual({ status: "paused" });
            } else {
              await Promise.all(launched);
            }
            if (winner === "document") {
              const cancelled = await f.act(
                f.safeDb(cancellation.db),
                "cancel",
              );
              expect(cancelled.isErr()).toBe(true);
              if (cancelled.isErr()) {
                expect(HandlerError.is(cancelled.error)).toBe(true);
                if (HandlerError.is(cancelled.error)) {
                  expect(cancelled.error.status).toBe(409);
                  expect(cancelled.error.message).toBe(
                    "This run has already finished.",
                  );
                }
              }
            }
            const state = await f.read();
            const output = state.steps.at(1)?.output;
            const saved = await db.query.entities.findMany({
              where: { id: { in: attemptedIds } },
              limit: 2,
            });
            if (winner === "revoke") {
              expect(state.run?.status).toBe("running");
              expect(state.steps.at(1)?.status).toBe("running");
              expect(output).toBeNull();
              expect(saved).toHaveLength(0);
            } else if (winner === "cancel" || winner === "cleanup-failure") {
              expect(state.run?.status).toBe("cancelled");
              expect(state.steps.at(1)?.status).toBe("skipped");
              expect(output).toBeNull();
              expect(saved).toHaveLength(0);
            } else {
              expect(state.run?.status).toBe("completed");
              expect(state.steps.at(1)?.status).toBe("completed");
              expect(saved).toHaveLength(1);
              const document = saved.at(0);
              if (!document) {
                panic("Completed document step has no saved entity");
              }
              expect(output).toEqual({
                kind: "create-document",
                entityId: document.id,
              });
            }
            if (winner === "revoke") {
              await db.insert(featureEnrolments).values({
                organizationId: f.organizationId,
                userId: f.userId,
                featureId: "flows",
              });
              expect(await start(worker)).toEqual({ status: "completed" });
              expect((await f.read()).run?.status).toBe("completed");
            } else {
              await start(worker);
            }
            expect(creations).toBe(
              winner === "duplicate" || winner === "revoke" ? 2 : 1,
            );
          } finally {
            release.resolve(undefined);
            await Promise.allSettled(launched);
            await f.cleanup();
          }
        });
      });
    }
  });
}

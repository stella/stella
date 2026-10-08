import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import {
  auditLogs,
  entities,
  entityLinks,
  featureEnrolments,
  flowRunSteps,
  workspaces,
  workspaceMembers,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import {
  copyEntities,
  ENTITY_SNAPSHOT_COLUMNS,
  EVERY_LIVE_VERSION_SELECT,
  remapFileIds,
} from "@/api/handlers/entities/copy-utils";
import { deleteEntitiesHandler } from "@/api/handlers/entities/delete";
import { moveEntityHandler } from "@/api/handlers/entities/move";
import readTaskById from "@/api/handlers/tasks/get";
import { createSafeId } from "@/api/lib/branded-types";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { admitTaskFlowMutation } from "@/api/lib/flows/review-task-admission";
import { createTaskEntityHandler } from "@/api/lib/tasks/create-task-entity";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  flowReviewGateFixture,
  waitForBlockedPid,
} from "@/api/tests/helpers/flow-review-gate";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const seedTargets = async (db: GatedTestDb) => {
  const f = await flowReviewGateFixture(db, { intermediate: false });
  const rootId = createSafeId<"entity">();
  const parentId = createSafeId<"entity">();
  const ordinaryId = createSafeId<"entity">();
  const linkId = createSafeId<"entityLink">();
  const targetWorkspaceId = createSafeId<"workspace">();
  await db.insert(workspaces).values({
    id: targetWorkspaceId,
    organizationId: f.organizationId,
    name: "Target",
    reference: targetWorkspaceId,
  });
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: targetWorkspaceId, userId: f.userId });
  const copyDb = createSafeDb(
    markRlsDatabase(db),
    [f.workspaceId, targetWorkspaceId],
    f.organizationId,
    f.userId,
  );
  await db.insert(entities).values([
    { id: rootId, workspaceId: f.workspaceId, kind: "folder", name: "Source" },
    {
      id: parentId,
      workspaceId: f.workspaceId,
      kind: "folder",
      name: "Destination",
    },
    {
      id: ordinaryId,
      workspaceId: f.workspaceId,
      kind: "document",
      name: "Ordinary document",
    },
  ]);
  await db
    .update(entities)
    .set({ parentId: rootId })
    .where(eq(entities.id, f.taskEntityId));
  await db.insert(entityLinks).values({
    id: linkId,
    workspaceId: f.workspaceId,
    sourceEntityId: ordinaryId,
    targetEntityId: f.taskEntityId,
  });
  const read = async () => ({
    source: await db
      .select()
      .from(entities)
      .where(eq(entities.workspaceId, f.workspaceId))
      .orderBy(asc(entities.id)),
    target: await db
      .select()
      .from(entities)
      .where(eq(entities.workspaceId, targetWorkspaceId))
      .orderBy(asc(entities.id)),
    flow: await f.read(),
    audit: await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.organizationId, f.organizationId))
      .orderBy(asc(auditLogs.id)),
  });
  const move = async (
    database: GatedTestDb,
    entityId: typeof rootId,
    destinationId: typeof parentId | null,
  ) =>
    await Result.gen(() =>
      moveEntityHandler({
        safeDb: f.safeDb(database),
        userId: f.userId,
        workspaceId: f.workspaceId,
        recordAuditEvent: f.recordAuditEvent,
        body: { entityId, parentId: destinationId },
      }),
    );
  const copy = async ({
    transfer,
    targetParentId = null,
    sourceRootId = rootId,
    targetWorkspace = targetWorkspaceId,
    targetRootEntityId,
  }: {
    transfer: "copy" | "move";
    targetParentId?: typeof parentId | null;
    sourceRootId?: typeof rootId;
    targetWorkspace?: typeof targetWorkspaceId;
    targetRootEntityId?: typeof rootId;
  }) => {
    const source = await db.query.entities.findMany({
      where: {
        workspaceId: { eq: f.workspaceId },
        id: {
          in:
            sourceRootId === rootId ? [rootId, f.taskEntityId] : [sourceRootId],
        },
      },
      columns: ENTITY_SNAPSHOT_COLUMNS,
      with: EVERY_LIVE_VERSION_SELECT,
    });
    const root =
      source.find((entity) => entity.id === sourceRootId) ??
      panic("Missing source root");
    const snapshot = [
      root,
      ...source.filter((entity) => entity.id !== sourceRootId),
    ];
    return await Result.gen(async function* () {
      const outcome = yield* Result.await(
        copyDb(
          async (tx) =>
            await copyEntities({
              tx,
              organizationId: f.organizationId,
              targetWorkspaceId: targetWorkspace,
              targetParentId,
              ...(targetRootEntityId === undefined
                ? {}
                : { targetRootEntityId }),
              userId: f.userId,
              recordAuditEvent: f.recordAuditEvent,
              sourceEntityId: sourceRootId,
              sourceWorkspaceId: f.workspaceId,
              sourceEntities: remapFileIds(snapshot, []),
              transfer:
                transfer === "move"
                  ? {
                      type: "move",
                      sourceWorkspaceId: f.workspaceId,
                      sourceSnapshot: snapshot,
                    }
                  : { type: "copy" },
              fieldMapping: { type: "omit" },
            }),
        ),
      );
      return yield* outcome;
    });
  };
  return {
    ...f,
    rootId,
    parentId,
    ordinaryId,
    linkId,
    targetWorkspaceId,
    readTargets: read,
    move,
    copy,
  };
};

if (!databaseUrl || !enabled) {
  describe.skip("review task mutation targets (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("review task mutation targets (postgres)", () => {
    test.each(["deployment-disabled", "grant-revoked"] as const)(
      "%s refuses the whole subtree and persisted relation targets",
      async (refusal) => {
        const previousFlag = env.FEATURE_FLOWS;
        const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
        env.FEATURE_FLOWS = refusal !== "deployment-disabled";
        try {
          await withGatedTestClients(databaseUrl, async ({ openClient }) => {
            const { db } = openClient();
            const f = await seedTargets(db);
            try {
              if (refusal === "grant-revoked") {
                await db
                  .delete(featureEnrolments)
                  .where(
                    and(
                      eq(featureEnrolments.organizationId, f.organizationId),
                      eq(featureEnrolments.userId, f.userId),
                      eq(featureEnrolments.featureId, "flows"),
                    ),
                  );
              }
              const before = await f.readTargets();
              const targets = [
                {
                  type: "subtree",
                  rootEntityIds: [f.rootId],
                  additionalEntityIds: [],
                },
                {
                  type: "subtree",
                  rootEntityIds: [f.ordinaryId],
                  additionalEntityIds: [f.taskEntityId],
                },
                { type: "entities", entityIds: [f.ordinaryId, f.taskEntityId] },
                { type: "link", linkId: f.linkId },
              ] as const;
              for (const target of targets) {
                const admission = await f.safeDb(db)(
                  async (tx) =>
                    await admitTaskFlowMutation(tx, {
                      workspaceId: f.workspaceId,
                      userId: f.userId,
                      target,
                    }),
                );
                const result = admission.andThen((value) => value);
                expect(result.isErr() && result.error).toMatchObject({
                  status: 404,
                  message: "Not found",
                });
              }
              const move = await f.move(db, f.rootId, f.parentId);
              expect(move.isErr() && move.error).toMatchObject({ status: 404 });
              const parent = await f.move(db, f.ordinaryId, f.taskEntityId);
              expect(parent.isErr() && parent.error).toMatchObject({
                status: 404,
              });
              const copy = await f.copy({ transfer: "copy" });
              expect(copy.isErr() && copy.error).toMatchObject({ status: 404 });
              const transfer = await f.copy({ transfer: "move" });
              expect(transfer.isErr() && transfer.error).toMatchObject({
                status: 404,
              });
              const parentCopy = await f.copy({
                transfer: "copy",
                sourceRootId: f.ordinaryId,
                targetWorkspace: f.workspaceId,
                targetParentId: f.taskEntityId,
              });
              expect(parentCopy.isErr() && parentCopy.error).toMatchObject({
                status: 404,
              });
              const replayTargetCopy = await f.copy({
                transfer: "copy",
                sourceRootId: f.ordinaryId,
                targetWorkspace: f.workspaceId,
                targetRootEntityId: f.taskEntityId,
              });
              expect(
                replayTargetCopy.isErr() && replayTargetCopy.error,
              ).toMatchObject({ status: 404 });
              expect(await f.readTargets()).toEqual(before);
            } finally {
              await f.cleanup();
            }
          });
        } finally {
          env.FEATURE_FLOWS = previousFlag;
          restore();
        }
      },
    );

    test("regrant permits same-matter relocation and ordinary documents while active transfer stays refused", async () => {
      const previousFlag = env.FEATURE_FLOWS;
      const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
      env.FEATURE_FLOWS = true;
      try {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const f = await seedTargets(db);
          try {
            await db
              .delete(featureEnrolments)
              .where(
                and(
                  eq(featureEnrolments.organizationId, f.organizationId),
                  eq(featureEnrolments.userId, f.userId),
                  eq(featureEnrolments.featureId, "flows"),
                ),
              );
            expect((await f.move(db, f.rootId, f.parentId)).isErr()).toBe(true);
            await db.insert(featureEnrolments).values({
              organizationId: f.organizationId,
              userId: f.userId,
              featureId: "flows",
            });
            expect((await f.move(db, f.rootId, f.parentId)).isOk()).toBe(true);
            const retained = await f.read();
            expect(retained.task?.id).toBe(f.taskEntityId);
            expect(retained.task?.parentId).toBe(f.rootId);
            expect(retained.steps.at(0)?.reviewTaskEntityId).toBe(
              f.taskEntityId,
            );
            expect(
              (
                await db.query.entities.findFirst({
                  where: { id: { eq: f.rootId } },
                })
              )?.parentId,
            ).toBe(f.parentId);
            expect((await f.move(db, f.ordinaryId, f.parentId)).isOk()).toBe(
              true,
            );
            const before = await f.readTargets();
            const transfer = await f.copy({ transfer: "move" });
            expect(transfer.isErr() && transfer.error).toMatchObject({
              status: 409,
            });
            const copy = await f.copy({ transfer: "copy" });
            expect(copy.isErr() && copy.error).toMatchObject({
              status: 400,
              message: "Entity has no current version",
            });
            expect(await f.readTargets()).toEqual(before);
          } finally {
            await f.cleanup();
          }
        });
      } finally {
        env.FEATURE_FLOWS = previousFlag;
        restore();
      }
    });

    test("parent deletion admits linked descendants and retains their review pointers when detached", async () => {
      const previousFlag = env.FEATURE_FLOWS;
      const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
      env.FEATURE_FLOWS = true;
      try {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const f = await seedTargets(db);
          const remove = async (entityId: typeof f.rootId) =>
            await Result.gen(() =>
              deleteEntitiesHandler({
                safeDb: f.safeDb(db),
                organizationId: f.organizationId,
                workspaceId: f.workspaceId,
                userId: f.userId,
                recordAuditEvent: f.recordAuditEvent,
                body: { entityIds: [entityId] },
              }),
            );
          const revoke = async () =>
            await db.transaction(async (tx) => {
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
          try {
            await revoke();
            const before = await f.readTargets();
            const hiddenParent = await remove(f.rootId);
            expect(hiddenParent.isErr() && hiddenParent.error).toMatchObject({
              status: 404,
              message: "Not found",
            });
            const hiddenTask = await remove(f.taskEntityId);
            expect(hiddenTask.isErr() && hiddenTask.error).toMatchObject({
              status: 404,
              message: "Not found",
            });
            expect(await f.readTargets()).toEqual(before);
            await db.transaction(async (tx) => {
              await lockFeatureRecoveryAdmission({
                tx,
                organizationId: f.organizationId,
                featureId: "flows",
              });
              await tx.insert(featureEnrolments).values({
                organizationId: f.organizationId,
                userId: f.userId,
                featureId: "flows",
              });
            });
            expect((await remove(f.rootId)).isOk()).toBe(true);
            expect(
              await db.query.entities.findFirst({
                where: { id: { eq: f.rootId } },
              }),
            ).toBeUndefined();
            const detached = await f.read();
            expect(detached.task).toMatchObject({
              id: f.taskEntityId,
              workspaceId: f.workspaceId,
              parentId: null,
            });
            expect(detached.run).toEqual(before.flow.run);
            expect(detached.steps).toEqual(before.flow.steps);
            expect(detached.steps.at(0)?.reviewTaskEntityId).toBe(
              f.taskEntityId,
            );
            const beforeActiveRefusal = await f.readTargets();
            const activeTask = await remove(f.taskEntityId);
            expect(activeTask.isErr() && activeTask.error).toMatchObject({
              status: 409,
            });
            expect(await f.readTargets()).toEqual(beforeActiveRefusal);
          } finally {
            await f.cleanup();
          }
        });
      } finally {
        env.FEATURE_FLOWS = previousFlag;
        restore();
      }
    });

    test("an admitted version-backed task copy keeps a fresh ordinary identity after revocation", async () => {
      const previousFlag = env.FEATURE_FLOWS;
      const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
      env.FEATURE_FLOWS = true;
      try {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const f = await seedTargets(db);
          try {
            const created = await Result.gen(async function* () {
              const outcome = yield* Result.await(
                f.safeDb(db)(
                  async (tx) =>
                    await Result.gen(() =>
                      createTaskEntityHandler({
                        tx,
                        workspaceId: f.workspaceId,
                        userId: f.userId,
                        recordAuditEvent: f.recordAuditEvent,
                        body: { name: "Version-backed review task" },
                        features: {
                          governedWorkflow: false,
                          legalLists: false,
                        },
                      }),
                    ),
                ),
              );
              return yield* outcome;
            });
            if (created.isErr()) {
              return panic("Task fixture creation failed", {
                error: created.error,
              });
            }
            const sourceId = created.value.entityId;
            await db.transaction(async (tx) => {
              await lockFeatureRecoveryAdmission({
                tx,
                organizationId: f.organizationId,
                featureId: "flows",
              });
              await tx
                .update(flowRunSteps)
                .set({ reviewTaskEntityId: sourceId })
                .where(eq(flowRunSteps.runId, f.runId));
            });
            const source = await db.query.entities.findFirst({
              where: { id: { eq: sourceId } },
            });
            if (!source || source.currentVersionId === null) {
              return panic("Task creator did not persist its current version");
            }
            const copy = await f.copy({
              transfer: "copy",
              sourceRootId: sourceId,
              targetWorkspace: f.workspaceId,
            });
            if (copy.isErr()) {
              return panic("Admitted task copy failed", { error: copy.error });
            }
            const copiedId = copy.value.entityId;
            expect(copiedId).not.toBe(sourceId);
            const copied = await db.query.entities.findFirst({
              where: { id: { eq: copiedId } },
            });
            expect(copied).toMatchObject({
              kind: "task",
              workspaceId: f.workspaceId,
            });
            if (!copied || copied.currentVersionId === null) {
              return panic("Task copy did not persist its current version");
            }
            expect(copied.currentVersionId).not.toBe(source.currentVersionId);
            expect(
              await db.$count(
                flowRunSteps,
                eq(flowRunSteps.reviewTaskEntityId, copiedId),
              ),
            ).toBe(0);
            expect((await f.read()).steps.at(0)?.reviewTaskEntityId).toBe(
              sourceId,
            );
            expect(
              await db.query.entities.findFirst({
                where: { id: { eq: sourceId } },
              }),
            ).toEqual(source);
            await db.transaction(async (tx) => {
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
            const readTask = async (taskId: typeof sourceId) =>
              await readTaskById.handler(
                createTestHandlerContext<
                  Parameters<typeof readTaskById.handler>[0]
                >({
                  safeDb: f.safeDb(db),
                  workspaceId: f.workspaceId,
                  user: { id: f.userId },
                  session: { activeOrganizationId: f.organizationId },
                  recordAuditEvent: f.recordAuditEvent,
                  params: { taskId },
                }),
              );
            expect(await readTask(sourceId)).toMatchObject({
              code: 404,
              response: { message: "Not found" },
            });
            expect(await readTask(copiedId)).toMatchObject({
              id: copiedId,
              kind: "task",
              flowReview: null,
            });
            expect((await f.read()).steps.at(0)?.reviewTaskEntityId).toBe(
              sourceId,
            );
          } finally {
            await f.cleanup();
          }
        });
      } finally {
        env.FEATURE_FLOWS = previousFlag;
        restore();
      }
    });

    test("revocation committed before target discovery refuses a waiting move", async () => {
      const previousFlag = env.FEATURE_FLOWS;
      const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
      env.FEATURE_FLOWS = true;
      try {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const setup = openClient();
          const writer = openClient();
          const observer = openClient();
          const arrived = Promise.withResolvers<undefined>();
          let targetDiscovered = false;
          const contender = openClient({
            logger: {
              logQuery(query) {
                if (query.includes("flow_run_steps")) {
                  targetDiscovered = true;
                }
                if (query.includes("pg_advisory_xact_lock")) {
                  arrived.resolve(undefined);
                }
              },
            },
            connection: { lock_timeout: 5000, statement_timeout: 10_000 },
          });
          const f = await seedTargets(setup.db);
          const locked = Promise.withResolvers<undefined>();
          const release = Promise.withResolvers<undefined>();
          let write: Promise<void> | undefined;
          let move: ReturnType<typeof f.move> | undefined;
          try {
            const before = await f.readTargets();
            const writerPid =
              (
                await writer.sql<
                  { pid: number }[]
                >`select pg_backend_pid() as pid`
              ).at(0)?.pid ?? panic("Missing writer PID");
            const waitingPid =
              (
                await contender.sql<
                  { pid: number }[]
                >`select pg_backend_pid() as pid`
              ).at(0)?.pid ?? panic("Missing contender PID");
            write = writer.db.transaction(async (tx) => {
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
              locked.resolve(undefined);
              await release.promise;
            });
            await locked.promise;
            move = f.move(contender.db, f.rootId, f.parentId);
            await arrived.promise;
            await waitForBlockedPid(observer.sql, {
              waitingPid,
              holdingPid: writerPid,
            });
            expect(targetDiscovered).toBe(false);
            release.resolve(undefined);
            await write;
            const result = await move;
            expect(targetDiscovered).toBe(true);
            expect(result.isErr() && result.error).toMatchObject({
              status: 404,
              message: "Not found",
            });
            expect(await f.readTargets()).toEqual(before);
          } finally {
            release.resolve(undefined);
            await write;
            await move;
            await f.cleanup();
          }
        });
      } finally {
        env.FEATURE_FLOWS = previousFlag;
        restore();
      }
    });
  });
}

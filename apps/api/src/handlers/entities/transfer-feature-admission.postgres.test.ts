import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import {
  entities,
  entityVersions,
  featureEnrolments,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { readEntityTransferEligibility } from "@/api/lib/flows/review-gate-task";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { createCopyToWorkspace } from "./copy";
import { createDuplicateEntity } from "./duplicate";
import { moveEntityHandler } from "./move";

const testState = createTestState({ file: import.meta.path, config: env });
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)(
  "entity transfer feature admission (postgres)",
  () => {
    for (const admission of ["deployment-disabled", "unenrolled"] as const) {
      test(`${admission}: retained review subtrees are unavailable while ordinary folders transfer`, async () => {
        const previous = env.FEATURE_FLOWS;
        const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
        testState.setConfig(
          "FEATURE_FLOWS",
          admission !== "deployment-disabled",
        );
        try {
          await withGatedTestClients(
            process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
            async ({ openClient }) => {
              const { db } = openClient();
              const f = await flowReviewGateFixture(db, {
                intermediate: false,
              });
              try {
                const sourceFolderId = createSafeId<"entity">();
                const ordinaryFolderId = createSafeId<"entity">();
                const targetFolderId = createSafeId<"entity">();
                const targetWorkspaceId = createSafeId<"workspace">();
                await db.insert(entities).values([
                  {
                    id: sourceFolderId,
                    workspaceId: f.workspaceId,
                    name: "Review folder",
                    kind: "folder",
                  },
                  {
                    id: ordinaryFolderId,
                    workspaceId: f.workspaceId,
                    name: "Ordinary folder",
                    kind: "folder",
                  },
                  {
                    id: targetFolderId,
                    workspaceId: f.workspaceId,
                    name: "Move target",
                    kind: "folder",
                  },
                ]);
                const sourceIds = [
                  sourceFolderId,
                  ordinaryFolderId,
                  targetFolderId,
                  f.taskEntityId,
                ];
                await db.insert(entityVersions).values(
                  sourceIds.map((entityId) => ({
                    id: createSafeId<"entityVersion">(),
                    workspaceId: f.workspaceId,
                    entityId,
                    versionNumber: 1,
                  })),
                );
                await db
                  .update(entities)
                  .set({ currentVersionId: sql`${entityVersions.id}` })
                  .from(entityVersions)
                  .where(
                    and(
                      eq(entities.workspaceId, f.workspaceId),
                      eq(entityVersions.workspaceId, f.workspaceId),
                      eq(entityVersions.entityId, entities.id),
                      inArray(entities.id, sourceIds),
                    ),
                  );
                await db
                  .update(entities)
                  .set({ parentId: sourceFolderId })
                  .where(eq(entities.id, f.taskEntityId));
                await db.insert(workspaces).values({
                  id: targetWorkspaceId,
                  organizationId: f.organizationId,
                  name: "Transfer target",
                  reference: targetWorkspaceId,
                });
                await db
                  .insert(workspaceMembers)
                  .values({ workspaceId: targetWorkspaceId, userId: f.userId });
                if (admission === "unenrolled") {
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
                const scoped = markRlsDatabase(db);
                const safeDb = createSafeDb(
                  scoped,
                  [f.workspaceId, targetWorkspaceId],
                  f.organizationId,
                  f.userId,
                );
                const scopedDb = createScopedDb(
                  scoped,
                  [f.workspaceId, targetWorkspaceId],
                  f.organizationId,
                  f.userId,
                );
                const decisions = await scopedDb(
                  async (tx) =>
                    await readEntityTransferEligibility(tx, {
                      workspaceId: f.workspaceId,
                      entityIds: [sourceFolderId, ordinaryFolderId],
                      userId: f.userId,
                    }),
                );
                expect(
                  decisions.find(({ entityId }) => entityId === sourceFolderId)
                    ?.eligible,
                ).toBe(false);
                expect(
                  decisions.find(
                    ({ entityId }) => entityId === ordinaryFolderId,
                  )?.eligible,
                ).toBe(true);
                expect(decisions).toHaveLength(2);
                const read = async () => ({
                  source: await db.query.entities.findMany({
                    where: { workspaceId: { eq: f.workspaceId } },
                    orderBy: { id: "asc" },
                  }),
                  target: await db.query.entities.findMany({
                    where: { workspaceId: { eq: targetWorkspaceId } },
                    orderBy: { id: "asc" },
                  }),
                  run: await f.read(),
                });
                const before = await read();
                let effects = 0;
                const recordAuditEvent = async () => {
                  effects += 1;
                };
                const handler = createCopyToWorkspace({
                  enqueueDocumentProcessingRun: async () => {
                    effects += 1;
                  },
                  enqueueEntitySearchRepairs: async () => {
                    effects += 1;
                  },
                  enqueueImageThumbnailOrMarkFailed: async () => {
                    effects += 1;
                  },
                  enqueuePdfDerivativeOrMarkFailed: async () => {
                    effects += 1;
                  },
                  flushEntitySearchRepairs: async () => ({
                    failed: 0,
                    repaired: 0,
                  }),
                  requestNativeExtractionRuns: async () => [],
                  syncWorkspaceSearchActivity: async () => undefined,
                });
                const copy = async (entityId: typeof sourceFolderId) =>
                  await handler.handler(
                    asTestRaw<Parameters<typeof handler.handler>[0]>({
                      workspaceId: f.workspaceId,
                      user: { id: f.userId, email: `${f.userId}@example.test` },
                      session: { activeOrganizationId: f.organizationId },
                      memberRole: sessionMemberRole("owner"),
                      request: new Request("https://example.test/transfer"),
                      route: "/v1/entities/:workspaceId/copy-to-workspace",
                      body: {
                        entityId,
                        targetWorkspaceId,
                        targetParentId: null,
                        deleteSource: false,
                      },
                      safeDb,
                      scopedDb,
                      recordAuditEvent,
                      createAuditRecorder: () => recordAuditEvent,
                      getWorkspaceAccess: async () => ({
                        id: targetWorkspaceId,
                        status: "active",
                      }),
                    }),
                  );
                expect(await copy(sourceFolderId)).toMatchObject({ code: 404 });
                const duplicate = createDuplicateEntity({
                  enqueueDocumentProcessingRun: async () => {
                    effects += 1;
                  },
                  enqueueEntitySearchRepairs: async () => {
                    effects += 1;
                  },
                  flushEntitySearchRepairs: async () => ({
                    failed: 0,
                    repaired: 0,
                  }),
                  requestNativeExtractionRuns: async () => [],
                });
                const duplicated = await duplicate.handler(
                  asTestRaw<Parameters<typeof duplicate.handler>[0]>({
                    workspaceId: f.workspaceId,
                    user: { id: f.userId, email: `${f.userId}@example.test` },
                    session: { activeOrganizationId: f.organizationId },
                    memberRole: sessionMemberRole("owner"),
                    request: new Request("https://example.test/duplicate"),
                    route: "/v1/entities/:workspaceId/duplicate",
                    body: { entityId: sourceFolderId },
                    safeDb,
                    scopedDb,
                    recordAuditEvent,
                  }),
                );
                expect(duplicated).toMatchObject({ code: 404 });
                const move = async (entityId: typeof sourceFolderId) =>
                  await Result.gen(() =>
                    moveEntityHandler({
                      safeDb,
                      workspaceId: f.workspaceId,
                      userId: f.userId,
                      recordAuditEvent,
                      body: { entityId, parentId: targetFolderId },
                      syncSearchActivity: async () => undefined,
                    }),
                  );
                const refused = await move(f.taskEntityId);
                expect(refused.isErr()).toBe(true);
                if (refused.isErr()) {
                  expect(refused.error).toMatchObject({ status: 404 });
                }
                expect(await read()).toEqual(before);
                expect(effects).toBe(0);
                const copied = await copy(ordinaryFolderId);
                expect(copied).toMatchObject({ entityId: expect.any(String) });
                const moved = await move(ordinaryFolderId);
                expect(moved.isOk()).toBe(true);
                expect(
                  await db.query.entities.findFirst({
                    where: { id: { eq: ordinaryFolderId } },
                  }),
                ).toMatchObject({ parentId: targetFolderId });
              } finally {
                await f.cleanup();
              }
            },
          );
        } finally {
          testState.setConfig("FEATURE_FLOWS", previous);
          restore();
        }
      });
    }
  },
);

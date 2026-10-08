import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import {
  cellMetadata,
  entities,
  featureEnrolments,
  fields,
} from "@/api/db/schema";
import { env } from "@/api/env";
import updateCellMetadata from "@/api/handlers/fields/cell-metadata/update";
import { createSafeId } from "@/api/lib/branded-types";
import { writeFieldValue } from "@/api/lib/fields/write-field";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { createTaskEntityHandler } from "@/api/lib/tasks/create-task-entity";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("task field mutation admission (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("task field mutation admission (postgres)", () => {
    test.each(["deployment-disabled", "grant-revoked"] as const)(
      "%s linked targets refuse field effects and parent creation before metadata errors",
      async (refusal) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const f = await flowReviewGateFixture(db, { intermediate: false });
          const previousFlag = env.FEATURE_FLOWS;
          const restoreRuntime = setRuntimeModeForTesting({
            mode: RUNTIME_MODE.strict,
          });
          env.FEATURE_FLOWS = refusal !== "deployment-disabled";
          const propertyId = createSafeId<"property">();
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
            const before = await f.read();
            const write = await Result.gen(() =>
              writeFieldValue({
                safeDb: f.safeDb(db),
                authority: sessionMemberRole("owner"),
                workspaceId: f.workspaceId,
                userId: f.userId,
                recordAuditEvent: f.recordAuditEvent,
                entityId: f.taskEntityId,
                propertyId,
                content: { version: 1, type: "text", value: "New value" },
              }),
            );
            expect(write.isErr() && write.error).toMatchObject({
              status: 404,
              message: "Not found",
            });
            const metadata = await updateCellMetadata.handler(
              createTestHandlerContext<
                Parameters<typeof updateCellMetadata.handler>[0]
              >({
                safeDb: f.safeDb(db),
                workspaceId: f.workspaceId,
                user: { id: f.userId },
                session: { activeOrganizationId: f.organizationId },
                recordAuditEvent: f.recordAuditEvent,
                body: { entityId: f.taskEntityId, propertyId, manualFlags: [] },
              }),
            );
            expect(metadata).toMatchObject({
              code: 404,
              response: { message: "Not found" },
            });
            const child = await Result.gen(() =>
              createTaskEntityHandler({
                safeDb: f.safeDb(db),
                workspaceId: f.workspaceId,
                userId: f.userId,
                recordAuditEvent: f.recordAuditEvent,
                body: { name: "Child task", parentId: f.taskEntityId },
                features: { governedWorkflow: false, legalLists: false },
              }),
            );
            expect(child.isErr() && child.error).toMatchObject({
              status: 404,
              message: "Not found",
            });
            expect(await f.read()).toEqual(before);
            expect(
              await db
                .select({ id: fields.id })
                .from(fields)
                .where(eq(fields.workspaceId, f.workspaceId)),
            ).toEqual([]);
            expect(
              await db
                .select({ id: cellMetadata.entityVersionId })
                .from(cellMetadata)
                .where(eq(cellMetadata.workspaceId, f.workspaceId)),
            ).toEqual([]);
            expect(
              await db
                .select({ id: entities.id })
                .from(entities)
                .where(eq(entities.workspaceId, f.workspaceId)),
            ).toEqual([{ id: f.taskEntityId }]);
          } finally {
            env.FEATURE_FLOWS = previousFlag;
            restoreRuntime();
            await f.cleanup();
          }
        });
      },
    );

    test("versionless ordinary tasks have no metadata target while document invariants remain", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const f = await flowReviewGateFixture(db, { intermediate: false });
        const taskId = createSafeId<"entity">();
        const documentId = createSafeId<"entity">();
        const propertyId = createSafeId<"property">();
        try {
          await db.insert(entities).values([
            {
              id: taskId,
              workspaceId: f.workspaceId,
              kind: "task",
              name: "Ordinary task",
            },
            {
              id: documentId,
              workspaceId: f.workspaceId,
              kind: "document",
              name: "Invalid document",
            },
          ]);
          const contextFor = (entityId: typeof taskId) =>
            createTestHandlerContext<
              Parameters<typeof updateCellMetadata.handler>[0]
            >({
              safeDb: f.safeDb(db),
              workspaceId: f.workspaceId,
              user: { id: f.userId },
              session: { activeOrganizationId: f.organizationId },
              recordAuditEvent: f.recordAuditEvent,
              body: { entityId, propertyId, manualFlags: [] },
            });
          const task = await updateCellMetadata.handler(contextFor(taskId));
          expect(task).toMatchObject({
            code: 404,
            response: { message: "Entity has no current version" },
          });
          expect(
            await updateCellMetadata.handler(contextFor(documentId)),
          ).toMatchObject({
            code: 500,
            response: { message: "Internal server error" },
          });
          const previousFlag = env.FEATURE_FLOWS;
          env.FEATURE_FLOWS = false;
          try {
            const child = await Result.gen(() =>
              createTaskEntityHandler({
                safeDb: f.safeDb(db),
                workspaceId: f.workspaceId,
                userId: f.userId,
                recordAuditEvent: f.recordAuditEvent,
                body: { name: "Ordinary child", parentId: taskId },
                features: { governedWorkflow: false, legalLists: false },
              }),
            );
            expect(child.isOk()).toBe(true);
          } finally {
            env.FEATURE_FLOWS = previousFlag;
          }
          expect(
            await db
              .select({ id: cellMetadata.entityVersionId })
              .from(cellMetadata)
              .where(eq(cellMetadata.workspaceId, f.workspaceId)),
          ).toEqual([]);
        } finally {
          await f.cleanup();
        }
      });
    });
  });
}

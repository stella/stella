import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  featureEnrolments,
  flowRuns,
  flowRunSteps,
  workspaces,
  workspaceMembers,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

import { createCopyToWorkspace } from "./copy";

const testState = createTestState({ file: import.meta.path, config: env });
test("refuses moving an active review task and retains both matters", async () => {
  const previousFlag = env.FEATURE_FLOWS;
  const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
  testState.setConfig("FEATURE_FLOWS", true);
  try {
    const db = await getTestDb();
    const organizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    const workspaceId = createSafeId<"workspace">();
    const taskEntityId = createSafeId<"entity">();
    const runId = createSafeId<"flowRun">();
    const read = async () => ({
      task: await db.query.entities.findFirst({
        where: { id: { eq: taskEntityId } },
      }),
      run: await db.query.flowRuns.findFirst({ where: { id: { eq: runId } } }),
      steps: await db.query.flowRunSteps.findMany({
        where: { runId: { eq: runId } },
      }),
    });
    try {
      await db.insert(organization).values({
        id: organizationId,
        name: "Transfer fixture",
        slug: organizationId,
        createdAt: new Date(),
      });
      await db.insert(user).values({
        id: userId,
        name: "Reviewer",
        email: `${userId}@example.test`,
        emailVerified: true,
      });
      await db.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      });
      await db
        .insert(featureEnrolments)
        .values({ organizationId, userId, featureId: "flows" });
      await db.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "Source matter",
        reference: workspaceId,
      });
      await db.insert(workspaceMembers).values({ workspaceId, userId });
      await db.insert(entities).values({
        id: taskEntityId,
        workspaceId,
        kind: "task",
        name: "Review task",
        status: "open",
      });
      await db.insert(flowRuns).values({
        id: runId,
        workspaceId,
        status: "awaiting_review",
        definitionSnapshot: {
          name: "Review flow",
          steps: [
            {
              kind: "review-gate",
              name: "Review",
              instructions: "Review output",
            },
          ],
        },
        triggerSource: { type: "manual", userId },
      });
      await db.insert(flowRunSteps).values({
        id: createSafeId<"flowRunStep">(),
        workspaceId,
        runId,
        index: 0,
        kind: "review-gate",
        reviewTaskEntityId: taskEntityId,
        status: "awaiting_review",
      });
      const targetWorkspaceId = createSafeId<"workspace">();
      const targetEntityId = createSafeId<"entity">();
      const versionId = createSafeId<"entityVersion">();
      await db.insert(workspaces).values({
        id: targetWorkspaceId,
        organizationId,
        name: "Target matter",
        reference: targetWorkspaceId,
      });
      await db.insert(workspaceMembers).values({
        workspaceId: targetWorkspaceId,
        userId,
      });
      await db.insert(entities).values({
        id: targetEntityId,
        workspaceId: targetWorkspaceId,
        kind: "task",
        name: "Existing task",
      });
      await db.insert(entityVersions).values({
        id: versionId,
        entityId: taskEntityId,
        workspaceId,
        versionNumber: 1,
      });
      await db
        .update(entities)
        .set({ currentVersionId: versionId })
        .where(eq(entities.id, taskEntityId));
      expect(
        await db.query.user.findFirst({ where: { id: { eq: userId } } }),
      ).toMatchObject({ emailVerified: true });
      const before = await read();
      expect(before.run?.status).toBe("awaiting_review");
      expect(before.steps.at(0)?.reviewTaskEntityId).toBe(taskEntityId);
      const targetBefore = await db.query.entities.findMany({
        where: { workspaceId: { eq: targetWorkspaceId } },
      });
      const noAudit = async () => undefined;
      const handler = createCopyToWorkspace({
        enqueueDocumentProcessingRun: async () => undefined,
        enqueueEntitySearchRepairs: async () => undefined,
        enqueueImageThumbnailOrMarkFailed: async () => undefined,
        enqueuePdfDerivativeOrMarkFailed: async () => undefined,
        flushEntitySearchRepairs: async () => ({ failed: 0, repaired: 0 }),
        requestNativeExtractionRuns: async () => [],
        syncWorkspaceSearchActivity: async () => undefined,
      });
      const result = await handler.handler(
        asTestRaw<Parameters<typeof handler.handler>[0]>({
          workspaceId,
          user: { id: userId, email: `${userId}@example.test` },
          session: { activeOrganizationId: organizationId },
          memberRole: sessionMemberRole("owner"),
          body: {
            entityId: taskEntityId,
            targetWorkspaceId,
            targetParentId: null,
            deleteSource: true,
          },
          request: new Request("https://example.test/transfer"),
          route: "/v1/workspaces/:workspaceId/entities/copy-to-workspace",
          safeDb: createSafeDb(
            db,
            [workspaceId, targetWorkspaceId],
            organizationId,
            userId,
          ),
          scopedDb: createScopedDb(
            db,
            [workspaceId, targetWorkspaceId],
            organizationId,
            userId,
          ),
          recordAuditEvent: noAudit,
          createAuditRecorder: () => noAudit,
          getWorkspaceAccess: async () => ({
            id: targetWorkspaceId,
            status: "active",
          }),
        }),
      );
      expect(result).toMatchObject({
        code: 409,
        response: {
          message: "An active workflow review task cannot be deleted",
        },
      });
      const after = await read();
      expect(after.task).toEqual(before.task);
      expect(after.steps).toEqual(before.steps);
      expect(
        await db.query.entities.findMany({
          where: { workspaceId: { eq: targetWorkspaceId } },
        }),
      ).toEqual(targetBefore);
    } finally {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, userId));
      await releaseTestDb();
    }
  } finally {
    testState.setConfig("FEATURE_FLOWS", previousFlag);
    restore();
  }
});

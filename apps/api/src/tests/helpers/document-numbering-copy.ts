import { panic, Result } from "better-result";
import { expect } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import { createSafeDb } from "@/api/db/scoped";
import { createCopyToWorkspace } from "@/api/handlers/entities/copy";
import { createEntitiesHandler } from "@/api/handlers/entities/create";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const copy = createCopyToWorkspace({
  enqueueDocumentProcessingRun: async () => await Promise.resolve(),
  enqueueEntitySearchRepairs: async () => await Promise.resolve(),
  enqueueImageThumbnailOrMarkFailed: async () => await Promise.resolve(),
  enqueuePdfDerivativeOrMarkFailed: async () => await Promise.resolve(),
  flushEntitySearchRepairs: async () =>
    await Promise.resolve({ failed: 0, repaired: 0 }),
  requestNativeExtractionRuns: async () => await Promise.resolve([]),
  syncWorkspaceSearchActivity: async () => await Promise.resolve(),
});

type RunNumberingCopyOptions = {
  testDb: TestDatabase;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  sourceWorkspaceId: SafeId<"workspace">;
  targetWorkspaceId: SafeId<"workspace">;
};

export const runNumberingCopy = async ({
  testDb,
  organizationId,
  userId,
  sourceWorkspaceId,
  targetWorkspaceId,
}: RunNumberingCopyOptions) => {
  const safeDb = asTestRaw<SafeDb>(
    createSafeDb(
      testDb,
      [sourceWorkspaceId, targetWorkspaceId],
      organizationId,
      userId,
    ),
  );
  const recordAuditEvent = async () => await Promise.resolve();
  const created = await Result.gen(() =>
    createEntitiesHandler({
      safeDb,
      workspaceId: sourceWorkspaceId,
      userId,
      recordAuditEvent,
      body: { name: "Copy source" },
    }),
  );
  expect(Result.isOk(created)).toBe(true);
  if (Result.isError(created)) {
    throw created.error;
  }
  const copied = await copy.handler(
    asTestRaw<Parameters<typeof copy.handler>[0]>({
      memberRole: sessionMemberRole("owner"),
      body: {
        entityId: created.value.entityId,
        targetWorkspaceId,
        targetParentId: null,
        deleteSource: false,
      },
      getWorkspaceAccess: async () =>
        await Promise.resolve({
          id: targetWorkspaceId,
          status: "active",
        }),
      createAuditRecorder: () => recordAuditEvent,
      recordAuditEvent,
      request: new Request("https://example.test/entities/copy"),
      route: "/test/entities/copy",
      safeDb,
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
      workspaceId: sourceWorkspaceId,
    }),
  );
  if ("code" in copied) {
    panic("Expected document copy to succeed");
  }
  expect(typeof copied.entityId).toBe("string");
  return copied;
};

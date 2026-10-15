import { panic } from "better-result";
import { expect } from "bun:test";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/node";

import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import presignUpload from "@/api/handlers/uploads/create";
import finalizeUpload from "@/api/handlers/uploads/update";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { TestDatabase } from "@/api/tests/security/test-utils";

type RunNumberingUploadOptions = {
  testDb: TestDatabase;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  propertyId: SafeId<"property">;
  entityId?: SafeId<"entity">;
};

// The caller owns the fixture database and fake S3 lifetime.
export const runNumberingUpload = async ({
  testDb,
  organizationId,
  userId,
  workspaceId,
  propertyId,
  entityId,
}: RunNumberingUploadOptions) => {
  const bytes = new TextEncoder().encode("Numbering upload fixture.\n");
  const fileMetadata = {
    name: "numbering-upload.txt",
    mimeType: "text/plain",
    size: bytes.byteLength,
    sha256Hex: hashSha256Hex(bytes),
  };
  const body =
    entityId === undefined
      ? { purpose: "entity_create" as const, propertyId, ...fileMetadata }
      : { purpose: "entity_version" as const, entityId, ...fileMetadata };
  const request = new Request(
    `https://example.test/workspaces/${workspaceId}/uploads`,
  );
  const auditBindings = {
    organizationId,
    userId,
    workspaceId,
    request,
    server: null,
  };
  const context = {
    getActiveWorkspaceIds: async () => await Promise.resolve([workspaceId]),
    getAccessibleWorkspaces: async () =>
      await Promise.resolve([{ id: workspaceId, status: "active" as const }]),
    getWorkspaceAccess: async () =>
      await Promise.resolve({
        id: workspaceId,
        status: "active" as const,
      }),
    pinServerValidatedWorkspaceId: (candidate: SafeId<"workspace">) =>
      candidate === workspaceId,
    createAuditRecorder: () => createAuditRecorder(auditBindings),
    recordAuditEvent: createAuditRecorder(auditBindings),
    memberRole: sessionMemberRole("owner"),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    managedAIResidency: "eu",
    promptCachingEnabled: false,
    request,
    route: "/test/uploads",
    safeDb: createSafeDb(testDb, [workspaceId], organizationId, userId),
    scopedDb: createScopedDb(testDb, [workspaceId], organizationId, userId),
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
    workspaceId,
  };

  const presigned = await presignUpload.handler(
    asTestRaw<Parameters<typeof presignUpload.handler>[0]>({
      ...context,
      body,
    }),
  );
  expect(presigned).toHaveProperty("uploadId");
  if (!("uploadId" in presigned)) {
    return panic("Expected a successful upload reservation");
  }

  const staged = await fetch(presigned.url, {
    method: "PUT",
    body: bytes,
    headers: presigned.headers,
  });
  expect(staged.status).toBe(200);

  const finalized = await finalizeUpload.handler(
    asTestRaw<Parameters<typeof finalizeUpload.handler>[0]>({
      ...context,
      params: { workspaceId, uploadId: presigned.uploadId },
    }),
  );
  expect(finalized).toHaveProperty("finalizedResult");
  if (!("finalizedResult" in finalized)) {
    return panic("Expected a successful upload finalization");
  }
  const { finalizedResult } = finalized;
  expect(finalizedResult.type).toBe(body.purpose);
  if (finalizedResult.type === "agent_skill") {
    return panic("Expected an entity upload result");
  }
  if (entityId !== undefined) {
    expect(finalizedResult.entityId).toBe(entityId);
  }

  const persisted = await testDb.query.pendingUploads.findFirst({
    where: {
      id: { eq: presigned.uploadId },
      workspaceId: { eq: workspaceId },
      userId: { eq: userId },
    },
    columns: { finalizedResult: true, status: true },
  });
  expect(persisted).toEqual({ status: "finalized", finalizedResult });

  return { uploadId: presigned.uploadId, finalizedResult };
};

import { eq } from "drizzle-orm";

import { createTestClock } from "@stll/test-kit";

import { member, organization, user } from "@/api/db/auth-schema";
import { rlsDb, rootDb } from "@/api/db/root";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/files/utils";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";

import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "./auth-provider-id";
import { deleteOrganizationsForTest } from "./organization-deletion";

/** Real current document versions in one scoped folder for storage consumers. */
export const storedDocumentConsumerFixture = () => {
  const clock = createTestClock();
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const folderId = createSafeId<"entity">();
  const propertyId = createSafeId<"property">();
  const scopedDb = createScopedDb(rlsDb, [workspaceId], organizationId, userId);
  const safeDb = safeDbFromScoped(scopedDb);
  return {
    organizationId,
    userId,
    workspaceId,
    folderId,
    scopedDb,
    safeDb,
    recordAuditEvent: createAuditRecorder({
      organizationId,
      workspaceId,
      userId,
      request: new Request("https://example.test/stored-document"),
      server: null,
    }),
    async seed() {
      await rootDb.insert(user).values({
        id: userId,
        name: "Document reader",
        email: `${userId}@example.test`,
      });
      await rootDb.insert(organization).values({
        id: organizationId,
        name: "Document storage",
        slug: organizationId,
        createdAt: new Date(clock.now()),
      });
      await recordNewOrganizationAccessState(rootDb, {
        organizationId,
        now: new Date(clock.now()),
      });
      await rootDb.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(clock.now()),
      });
      await rootDb.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "Document matter",
        reference: "STORAGE-1",
        status: "active",
      });
      await rootDb
        .insert(workspaceMembers)
        .values({ id: createSafeId<"workspaceMember">(), workspaceId, userId });
      await rootDb.insert(entities).values({
        id: folderId,
        workspaceId,
        kind: "folder",
        name: "Documents",
      });
      await rootDb.insert(properties).values({
        id: propertyId,
        workspaceId,
        name: "File",
        content: { version: 1, type: "file" },
        tool: { version: 1, type: "manual-input" },
        status: "fresh",
      });
    },
    async addDocument({
      fileName,
      mimeType,
    }: {
      fileName: string;
      mimeType: string;
    }) {
      const entityId = createSafeId<"entity">();
      const entityVersionId = createSafeId<"entityVersion">();
      const fieldId = createSafeId<"field">();
      const fileId = createSafeId<"userFile">();
      await rootDb.insert(entities).values({
        id: entityId,
        workspaceId,
        parentId: folderId,
        kind: "document",
        name: fileName,
      });
      await rootDb
        .insert(entityVersions)
        .values({ id: entityVersionId, entityId, workspaceId });
      await rootDb
        .update(entities)
        .set({ currentVersionId: entityVersionId })
        .where(eq(entities.id, entityId));
      await rootDb.insert(fields).values({
        id: fieldId,
        workspaceId,
        propertyId,
        entityVersionId,
        content: {
          version: 1,
          type: "file",
          id: fileId,
          fileName,
          mimeType,
          sizeBytes: 1,
          encrypted: false,
          sha256Hex: "a".repeat(64),
          pdfFileId: null,
        },
      });
      return {
        entityId,
        entityVersionId,
        fieldId,
        fileId,
        key: createFileKey({ organizationId, workspaceId, fileId, mimeType }),
      };
    },
    async dispose() {
      await deleteOrganizationsForTest(rootDb, [organizationId]);
      await rootDb.delete(user).where(eq(user.id, userId));
    },
  };
};

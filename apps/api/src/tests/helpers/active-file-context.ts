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
import { createSafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/files/utils";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";

import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "./auth-provider-id";
import { deleteOrganizationsForTest } from "./organization-deletion";

/** A current file owned by an actual scoped matter for prompt/evidence reads. */
export const activeFileContextFixture = ({
  fileName,
  mimeType,
}: {
  fileName: string;
  mimeType: string;
}) => {
  const clock = createTestClock();
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const propertyId = createSafeId<"property">();
  const source = {
    entityId: createSafeId<"entity">(),
    entityVersionId: createSafeId<"entityVersion">(),
    fieldId: createSafeId<"field">(),
    fileId: createSafeId<"userFile">(),
    fileName,
    mimeType,
    sha256Hex: "a".repeat(64),
  };
  const safeDb = safeDbFromScoped(
    createScopedDb(rlsDb, [workspaceId], organizationId, userId),
  );
  return {
    organizationId,
    workspaceId,
    source,
    safeDb,
    key: createFileKey({
      organizationId,
      workspaceId,
      fileId: source.fileId,
      mimeType,
    }),
    async seed() {
      await rootDb.insert(user).values({
        id: userId,
        name: "File context reader",
        email: `${userId}@example.test`,
      });
      await rootDb.insert(organization).values({
        id: organizationId,
        name: "File context",
        slug: `file-context-${organizationId}`,
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
        name: "File context matter",
        reference: "CONTEXT-1",
        status: "active",
      });
      await rootDb.insert(workspaceMembers).values({
        id: createSafeId<"workspaceMember">(),
        workspaceId,
        userId,
      });
      await rootDb.insert(entities).values({
        id: source.entityId,
        workspaceId,
        kind: "document",
        name: fileName,
      });
      await rootDb.insert(entityVersions).values({
        id: source.entityVersionId,
        entityId: source.entityId,
        workspaceId,
      });
      await rootDb
        .update(entities)
        .set({ currentVersionId: source.entityVersionId })
        .where(eq(entities.id, source.entityId));
      await rootDb.insert(properties).values({
        id: propertyId,
        workspaceId,
        name: "File",
        content: { version: 1, type: "file" },
        tool: { version: 1, type: "manual-input" },
        status: "fresh",
      });
      await rootDb.insert(fields).values({
        id: source.fieldId,
        workspaceId,
        propertyId,
        entityVersionId: source.entityVersionId,
        content: {
          version: 1,
          type: "file",
          id: source.fileId,
          fileName,
          mimeType,
          sizeBytes: 1,
          encrypted: false,
          sha256Hex: source.sha256Hex,
          pdfFileId: null,
        },
      });
    },
    async dispose() {
      await deleteOrganizationsForTest(rootDb, [organizationId]);
      await rootDb.delete(user).where(eq(user.id, userId));
    },
  };
};

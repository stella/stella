import { Result } from "better-result";
import { eq, inArray } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { member } from "@/api/db/auth-schema";
import {
  chatThreads,
  entities,
  entityVersions,
  fields,
  properties,
  propertyDependencies,
  userFiles,
  workspaces,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { deleteS3Keys, deleteS3Objects } from "@/api/handlers/files/utils";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const changeWorkspaceStatus = async (
  scopedDb: ScopedDb,
  workspaceId: SafeId<"workspace">,
  newStatus: "deleting" | "active",
) =>
  await scopedDb((tx) =>
    tx
      .update(workspaces)
      .set({ status: newStatus })
      .where(eq(workspaces.id, workspaceId)),
  );

type FileRef = { fileId: string; mimeType: string };

/** Extract source and converted-PDF refs from file content. */
const extractFileRefs = (content: FieldContent): FileRef[] => {
  if (content.type !== "file") {
    return [];
  }

  const refs: FileRef[] = [{ fileId: content.id, mimeType: content.mimeType }];

  if (content.pdfFileId) {
    refs.push({
      fileId: content.pdfFileId,
      mimeType: PDF_MIME_TYPE,
    });
  }

  return refs;
};

const config = {
  permissions: { workspace: ["delete"] },
} satisfies HandlerConfig;

const deleteWorkspace = createHandler(
  config,
  async ({ scopedDb, workspaceId, session }) => {
    const organizationId = session.activeOrganizationId;

    try {
      // Seal workspace: no new uploads.
      await changeWorkspaceStatus(scopedDb, workspaceId, "deleting");

      // Query file metadata from fields.content JSONB.
      // Workspace is sealed by status: "deleting", so no
      // concurrent uploads can insert new files.
      const [fileRefs, chatFileRefs] = await scopedDb(async (tx) => {
        const workspaceEntityVersionIds = tx
          .select({ id: entityVersions.id })
          .from(entityVersions)
          .innerJoin(entities, eq(entityVersions.entityId, entities.id))
          .where(eq(entities.workspaceId, workspaceId));

        const fileRefsPromise = tx
          .select({ content: fields.content })
          .from(fields)
          .where(inArray(fields.entityVersionId, workspaceEntityVersionIds))
          .then((fieldRows) =>
            fieldRows.flatMap((row) => extractFileRefs(row.content)),
          );

        const chatFileRefsPromise = tx
          .select({
            id: userFiles.id,
            s3Key: userFiles.s3Key,
          })
          .from(userFiles)
          .innerJoin(chatThreads, eq(userFiles.threadId, chatThreads.id))
          .where(eq(chatThreads.workspaceId, workspaceId));

        return await Promise.all([fileRefsPromise, chatFileRefsPromise]);
      });

      // Delete S3 objects outside any transaction.
      // On retry, already-deleted S3 objects are no-ops.
      const s3Deletes: Promise<void>[] = [];

      if (fileRefs.length > 0) {
        s3Deletes.push(
          deleteS3Objects({
            fileRows: fileRefs,
            organizationId,
            workspaceId,
          }).then((result) => Result.unwrap(result)),
        );
      }

      if (chatFileRefs.length > 0) {
        s3Deletes.push(
          deleteS3Keys(chatFileRefs.map((file) => file.s3Key)).then((result) =>
            Result.unwrap(result),
          ),
        );
      }

      await Promise.all(s3Deletes);

      // All S3 objects are gone. Delete DB records in a
      // single transaction.
      await scopedDb(async (tx) => {
        if (chatFileRefs.length > 0) {
          await tx.delete(userFiles).where(
            inArray(
              userFiles.id,
              chatFileRefs.map((file) => file.id),
            ),
          );
        }

        await tx
          .delete(chatThreads)
          .where(eq(chatThreads.workspaceId, workspaceId));

        // Delete property dependencies (restrict FK prevents
        // cascade, so explicit cleanup is needed).
        const workspacePropertyIds = tx
          .select({ id: properties.id })
          .from(properties)
          .where(eq(properties.workspaceId, workspaceId));

        await tx
          .delete(propertyDependencies)
          .where(
            inArray(
              propertyDependencies.dependsOnPropertyId,
              workspacePropertyIds,
            ),
          );

        // Delete entities: cascades to entityVersions ->
        // fields -> justifications.
        await tx.delete(entities).where(eq(entities.workspaceId, workspaceId));

        // Clear lastActiveWorkspaceId for members pointing
        // to this workspace (no FK constraint due to
        // circular schema dependency).
        await tx
          .update(member)
          .set({ lastActiveWorkspaceId: null })
          .where(eq(member.lastActiveWorkspaceId, workspaceId));

        // Delete workspace: cascades to properties ->
        // propertyDependencies. Entities already gone.
        await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
      });

      return;
    } catch (error) {
      await changeWorkspaceStatus(scopedDb, workspaceId, "active");
      throw error;
    }
  },
);

export default deleteWorkspace;

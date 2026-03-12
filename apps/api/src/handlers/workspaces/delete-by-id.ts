import { Result } from "better-result";
import { eq, inArray } from "drizzle-orm";
import { status } from "elysia";
import { ActorError } from "rivetkit/errors";

import { getBBoxActorConfig } from "@stella/rivet/actors/b-box-actor-config";
import { getViewsActorConfig } from "@stella/rivet/actors/views-actor-config";
import { getWorkflowActorConfig } from "@stella/rivet/actors/workflow-actor-config";

import type { ScopedDb } from "@/api/db";
import { member } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  fields,
  properties,
  propertyDependencies,
  workspaces,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { deleteS3Objects } from "@/api/handlers/files/utils";
import { rivet } from "@/api/handlers/registry";
import type { SafeId } from "@/api/lib/branded-types";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const isActorNotFound = (error: unknown): boolean =>
  error instanceof ActorError && error.code === "not_found";

type DestroyResult = { success: true } | { success: false };

/**
 * Attempt to destroy an actor. If the actor doesn't exist,
 * treat it as a successful no-op.
 */
const safeDestroy = async (
  actorCall: () => Promise<DestroyResult>,
): Promise<DestroyResult> => {
  try {
    return await actorCall();
  } catch (error) {
    if (isActorNotFound(error)) {
      return { success: true };
    }
    throw error;
  }
};

type DeleteWorkspaceHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  authToken: string;
};

// The workspace is in the user's workspace_ids when deleting
// (the route validates workspace access). The route guards
// this with permissions: { workspace: ['delete'] }.
export const changeWorkspaceStatus = async (
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

export const deleteWorkspaceHandler = async ({
  scopedDb,
  workspaceId,
  organizationId,
  authToken,
}: DeleteWorkspaceHandlerProps) => {
  try {
    // Destroy actors while workspace is still active;
    // actor connection validation rejects non-active
    // workspaces.
    const workflowActorConfig = getWorkflowActorConfig({
      type: "vanilla",
      authToken,
      organizationId,
      workspaceId,
    });

    const bBoxActorConfig = getBBoxActorConfig({
      type: "vanilla",
      authToken,
      organizationId,
      workspaceId,
    });

    const viewsActorConfig = getViewsActorConfig({
      type: "vanilla",
      authToken,
      organizationId,
      workspaceId,
    });

    const workflowActor = rivet.workflow.get(...workflowActorConfig);
    const bBoxActor = rivet.bBox.get(...bBoxActorConfig);
    const viewsActorHandle = rivet.views.get(...viewsActorConfig);

    const [workflowDestroy, bBoxDestroy, viewsDestroy] = await Promise.all([
      safeDestroy(async () => await workflowActor.destroy()),
      safeDestroy(async () => await bBoxActor.destroy()),
      safeDestroy(async () => await viewsActorHandle.destroy()),
    ]);

    if (
      !workflowDestroy.success ||
      !bBoxDestroy.success ||
      !viewsDestroy.success
    ) {
      // TODO: log this error
      return status(500);
    }

    // Seal workspace: no new uploads or actor connections.
    await changeWorkspaceStatus(scopedDb, workspaceId, "deleting");

    // Query file metadata from fields.content JSONB.
    // Workspace is sealed by status: "deleting", so no
    // concurrent uploads can insert new files.
    const fileRefs = await scopedDb(async (tx) => {
      const workspaceEntityVersionIds = tx
        .select({ id: entityVersions.id })
        .from(entityVersions)
        .innerJoin(entities, eq(entityVersions.entityId, entities.id))
        .where(eq(entities.workspaceId, workspaceId));

      const fieldRows = await tx
        .select({ content: fields.content })
        .from(fields)
        .where(inArray(fields.entityVersionId, workspaceEntityVersionIds));

      return fieldRows.flatMap((row) => extractFileRefs(row.content));
    });

    // Delete S3 objects outside any transaction.
    // On retry, already-deleted S3 objects are no-ops.
    if (fileRefs.length > 0) {
      Result.unwrap(
        await deleteS3Objects({
          fileRows: fileRefs,
          organizationId,
          workspaceId,
        }),
      );
    }

    // All S3 objects are gone. Delete DB records in a
    // single transaction.
    await scopedDb(async (tx) => {
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

      // Delete entities: cascades to entityVersions →
      // fields → justifications.
      await tx.delete(entities).where(eq(entities.workspaceId, workspaceId));

      // Clear lastActiveWorkspaceId for members pointing
      // to this workspace (no FK constraint due to circular
      // schema dependency).
      await tx
        .update(member)
        .set({ lastActiveWorkspaceId: null })
        .where(eq(member.lastActiveWorkspaceId, workspaceId));

      // Delete workspace: cascades to properties →
      // propertyDependencies. Entities already gone.
      await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
    });

    return;
  } catch (error) {
    await changeWorkspaceStatus(scopedDb, workspaceId, "active");
    throw error;
  }
};

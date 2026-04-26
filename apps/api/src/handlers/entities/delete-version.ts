import { Result } from "better-result";
import { and, desc, eq, ne } from "drizzle-orm";

import { entities, entityVersions } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { deleteS3Objects } from "@/api/handlers/files/utils";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { broadcast } from "@/api/lib/sse";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const paramsSchema = workspaceParams({
  entityId: tSafeId("entity"),
  versionId: tSafeId("entityVersion"),
});

const config = {
  permissions: { entity: ["update"] },
  params: paramsSchema,
} satisfies HandlerConfig;

type FileRef = { fileId: string; mimeType: string };

const extractFileRefs = (content: FieldContent): FileRef[] => {
  if (content.type !== "file") {
    return [];
  }
  const refs: FileRef[] = [{ fileId: content.id, mimeType: content.mimeType }];
  if (content.pdfFileId) {
    refs.push({ fileId: content.pdfFileId, mimeType: PDF_MIME_TYPE });
  }
  return refs;
};

export default createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, session }) {
    const organizationId = session.activeOrganizationId;

    // Verify the version belongs to this entity in this workspace
    const version = yield* Result.await(
      safeDb((tx) =>
        tx.query.entityVersions.findFirst({
          where: {
            id: { eq: params.versionId },
            entityId: { eq: params.entityId },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true, versionNumber: true },
        }),
      ),
    );

    if (!version) {
      return Result.err(
        new HandlerError({ status: 404, message: "Version not found" }),
      );
    }

    // Count total versions — can't delete the last one
    const allVersions = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: entityVersions.id,
            versionNumber: entityVersions.versionNumber,
          })
          .from(entityVersions)
          .where(
            and(
              eq(entityVersions.entityId, params.entityId),
              eq(entityVersions.workspaceId, workspaceId),
            ),
          )
          .orderBy(desc(entityVersions.versionNumber)),
      ),
    );

    if (allVersions.length <= 1) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Cannot delete the only remaining version",
        }),
      );
    }

    // Get file fields for S3 cleanup
    const versionFields = yield* Result.await(
      safeDb((tx) =>
        tx.query.fields.findMany({
          where: { entityVersionId: { eq: params.versionId } },
          columns: { content: true },
        }),
      ),
    );

    const fileRefs = versionFields.flatMap((row) =>
      extractFileRefs(row.content),
    );

    // Delete S3 objects first (idempotent on retry)
    if (fileRefs.length > 0) {
      Result.unwrap(
        await deleteS3Objects({
          fileRows: fileRefs,
          organizationId,
          workspaceId,
        }),
      );
    }

    // Check if this is the current version
    const entity = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: { eq: params.entityId },
            workspaceId: { eq: workspaceId },
          },
          columns: { currentVersionId: true },
        }),
      ),
    );

    const isDeletingCurrent = entity?.currentVersionId === params.versionId;

    yield* Result.await(
      safeDb(async (tx) => {
        // If deleting the current version, promote the next latest FIRST
        // (FK constraint on entities.currentVersionId is RESTRICT)
        if (isDeletingCurrent) {
          const nextLatest = await tx
            .select({ id: entityVersions.id })
            .from(entityVersions)
            .where(
              and(
                eq(entityVersions.entityId, params.entityId),
                eq(entityVersions.workspaceId, workspaceId),
                ne(entityVersions.id, params.versionId),
              ),
            )
            .orderBy(desc(entityVersions.versionNumber))
            .limit(1);

          const next = nextLatest.at(0);
          if (next) {
            await tx
              .update(entities)
              .set({
                currentVersionId: next.id,
                updatedAt: new Date(),
              })
              .where(eq(entities.id, params.entityId));
          }
        }

        // Now safe to delete the version (cascade removes fields)
        await tx
          .delete(entityVersions)
          .where(
            and(
              eq(entityVersions.id, params.versionId),
              eq(entityVersions.workspaceId, workspaceId),
            ),
          );
      }),
    );

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["entities", workspaceId],
    });

    return Result.ok({ deleted: true });
  },
);

import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t, type Static } from "elysia";

import { db } from "@/api/db";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { deleteS3Objects, PDF_MIME_TYPE } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";

export const deleteEntitiesBodySchema = t.Object({
  entityIds: t.Array(tNanoid, { minItems: 1 }),
});

type DeleteEntitiesBodySchema = Static<typeof deleteEntitiesBodySchema>;

type DeleteEntitiesHandlerProps = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  body: DeleteEntitiesBodySchema;
};

type FileRef = { fileId: string; mimeType: string };

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

export const deleteEntitiesHandler = async ({
  organizationId,
  workspaceId,
  body,
}: DeleteEntitiesHandlerProps) => {
  const entityVersionIds = db
    .select({ id: entityVersions.id })
    .from(entityVersions)
    .innerJoin(entities, eq(entityVersions.entityId, entities.id))
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        inArray(entities.id, body.entityIds),
      ),
    );

  const fieldRows = await db
    .select({ content: fields.content })
    .from(fields)
    .where(inArray(fields.entityVersionId, entityVersionIds));

  const fileRefs = fieldRows.flatMap((row) => extractFileRefs(row.content));

  // Delete S3 objects before the DB delete.
  // On retry, already-deleted objects are no-ops.

  Result.unwrap(
    await deleteS3Objects({
      fileRows: fileRefs,
      organizationId,
      workspaceId,
    }),
  );

  // Cascade: entities → entityVersions → fields →
  // justifications (all cascade).
  await db
    .delete(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        inArray(entities.id, body.entityIds),
      ),
    );

  await db
    .update(workspaces)
    .set({ lastActivityAt: new Date() })
    .where(eq(workspaces.id, workspaceId));

  return;
};

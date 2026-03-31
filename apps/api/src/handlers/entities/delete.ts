import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { deleteS3Objects } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { getSearchProvider } from "@/api/lib/search/provider";
import { PDF_MIME_TYPE } from "@/api/mime-types";

export const deleteEntitiesBodySchema = t.Object({
  entityIds: t.Array(tNanoid, { minItems: 1 }),
});

type DeleteEntitiesBodySchema = Static<typeof deleteEntitiesBodySchema>;

type DeleteEntitiesHandlerProps = {
  scopedDb: ScopedDb;
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
  scopedDb,
  organizationId,
  workspaceId,
  body,
}: DeleteEntitiesHandlerProps) => {
  const fieldRows = await scopedDb((tx) => {
    const entityVersionIds = tx
      .select({ id: entityVersions.id })
      .from(entityVersions)
      .innerJoin(entities, eq(entityVersions.entityId, entities.id))
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          inArray(entities.id, body.entityIds),
        ),
      );

    return tx
      .select({ content: fields.content })
      .from(fields)
      .where(inArray(fields.entityVersionId, entityVersionIds));
  });

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
  await scopedDb((tx) =>
    tx
      .delete(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          inArray(entities.id, body.entityIds),
        ),
      ),
  );

  await scopedDb((tx) =>
    tx
      .update(workspaces)
      .set({ lastActivityAt: new Date() })
      .where(eq(workspaces.id, workspaceId)),
  );

  // Explicit removal for non-PG providers (CASCADE handles PG)
  const provider = getSearchProvider();
  for (const id of body.entityIds) {
    provider.removeEntity(id).catch(captureError);
  }

  return;
};

const config = {
  permissions: { entity: ["delete"] },
  body: deleteEntitiesBodySchema,
} satisfies HandlerConfig;

const deleteEntities = createHandler(
  config,
  async ({ scopedDb, session, workspaceId, body }) =>
    await deleteEntitiesHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      body,
    }),
);

export default deleteEntities;

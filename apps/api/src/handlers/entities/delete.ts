import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { THUMBNAIL_MIME_TYPE } from "@/api/handlers/files/image-derivative";
import { deleteS3Objects } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getSearchProvider } from "@/api/lib/search/provider";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const deleteEntitiesBodySchema = t.Object({
  entityIds: t.Array(tSafeId("entity"), { minItems: 1 }),
});

type DeleteEntitiesBodySchema = Static<typeof deleteEntitiesBodySchema>;

type DeleteEntitiesHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
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

  if (content.thumbnailFileId) {
    refs.push({
      fileId: content.thumbnailFileId,
      mimeType: THUMBNAIL_MIME_TYPE,
    });
  }

  return refs;
};

const deleteEntitiesHandler = async function* ({
  safeDb,
  organizationId,
  workspaceId,
  recordAuditEvent,
  body,
}: DeleteEntitiesHandlerProps) {
  const readOnlyEntities = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findMany({
        where: {
          id: { in: body.entityIds },
          readOnly: { eq: true },
          workspaceId: { eq: workspaceId },
        },
        columns: { id: true },
      }),
    ),
  );
  if (readOnlyEntities.length > 0) {
    return Result.err(
      new HandlerError({ status: 409, message: "Entity is read-only" }),
    );
  }

  const fieldRows = yield* Result.await(
    safeDb((tx) => {
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
    }),
  );

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
  const deletedEntities = yield* Result.await(
    safeDb(async (tx) => {
      const deleted = await tx
        .delete(entities)
        .where(
          and(
            eq(entities.workspaceId, workspaceId),
            inArray(entities.id, body.entityIds),
          ),
        )
        .returning({
          id: entities.id,
          kind: entities.kind,
          name: entities.name,
          parentId: entities.parentId,
        });

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, workspaceId));

      await recordAuditEvent(
        tx,
        deleted.map((entity) => ({
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: entity.id,
          changes: {
            deleted: {
              old: {
                kind: entity.kind,
                name: entity.name,
                parentId: entity.parentId,
              },
              new: null,
            },
          },
        })),
      );

      return deleted;
    }),
  );

  // Explicit removal for non-PG providers (CASCADE handles PG)
  const provider = getSearchProvider();
  for (const entity of deletedEntities) {
    provider.removeEntity(entity.id).catch(captureError);
  }

  return Result.ok(undefined);
};

const config = {
  permissions: { entity: ["delete"] },
  body: deleteEntitiesBodySchema,
} satisfies HandlerConfig;

const deleteEntities = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, body, recordAuditEvent }) {
    return yield* deleteEntitiesHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default deleteEntities;

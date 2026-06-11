import { Result } from "better-result";
import { and, desc, eq, ne } from "drizzle-orm";

import { entities, entityVersions } from "@/api/db/schema";
import {
  extractFieldFileRefs,
  filterUnreferencedFieldFileRefs,
} from "@/api/handlers/files/field-file-refs";
import { deleteS3Objects } from "@/api/handlers/files/utils";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { broadcast } from "@/api/lib/sse";

const paramsSchema = workspaceParams({
  entityId: tSafeId("entity"),
  versionId: tSafeId("entityVersion"),
});

const config = {
  permissions: { entity: ["update"] },
  params: paramsSchema,
} satisfies HandlerConfig;

export default createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, session, recordAuditEvent }) {
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

    // Check if this is the current version before irreversible file cleanup.
    const entity = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: { eq: params.entityId },
            workspaceId: { eq: workspaceId },
          },
          columns: { currentVersionId: true, readOnly: true },
        }),
      ),
    );
    if (entity?.readOnly) {
      return Result.err(
        new HandlerError({ status: 409, message: "Entity is read-only" }),
      );
    }

    const isDeletingCurrent = entity?.currentVersionId === params.versionId;

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
      extractFieldFileRefs(row.content),
    );
    const unreferencedFileRefs = yield* Result.await(
      safeDb(
        async (tx) =>
          await filterUnreferencedFieldFileRefs({
            tx,
            workspaceId,
            fileRows: fileRefs,
            excludedEntityVersionIds: [params.versionId],
          }),
      ),
    );

    // Delete S3 objects first (idempotent on retry)
    if (unreferencedFileRefs.length > 0) {
      Result.unwrap(
        await deleteS3Objects({
          fileRows: unreferencedFileRefs,
          organizationId,
          workspaceId,
        }),
      );
    }

    yield* Result.await(
      safeDb(async (tx) => {
        // If deleting the current version, promote the next latest FIRST
        // (FK constraint on entities.currentVersionId is RESTRICT)
        let promotedVersionId: typeof params.versionId | null = null;
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
            promotedVersionId = next.id;
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

        const events: AuditEvent[] = [
          {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
            resourceId: params.versionId,
            changes: {
              deleted: {
                old: {
                  entityId: params.entityId,
                  versionNumber: version.versionNumber,
                },
                new: null,
              },
            },
          },
        ];
        if (promotedVersionId) {
          events.push({
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
            resourceId: params.entityId,
            changes: {
              currentVersionId: {
                old: params.versionId,
                new: promotedVersionId,
              },
            },
          });
        }
        await recordAuditEvent(tx, events);
      }),
    );

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["entities", workspaceId],
    });

    return Result.ok({ deleted: true });
  },
);

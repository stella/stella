import { Result } from "better-result";
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import {
  desktopEditSessions,
  documentProcessingRuns,
  entities,
  entityVersions,
  fields,
  folioCollabRooms,
  searchDocuments,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { lockDocxEditTarget } from "@/api/lib/entity-versions/desktop-edit-session-utils";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  broadcastWorkspaceResourceSetUpdated,
  broadcastWorkspaceResourceUpdated,
} from "@/api/lib/resource-realtime";
import { processExtraction } from "@/api/lib/search/process-extraction";

const paramsSchema = workspaceParams({
  entityId: tSafeId("entity"),
  versionId: tSafeId("entityVersion"),
});

const config = {
  description:
    "Tombstone one version of a document: it disappears from listings, " +
    "downloads, and restores, but the row and its stored file are retained for " +
    "chain of custody. Deleting the current version promotes the next " +
    "surviving one; the last remaining version, a read-only document, and a " +
    "version still being processed are refused.",
  permissions: { entity: ["update"] },
  mcp: { type: "covered", by: "delete_document" },
  params: paramsSchema,
} satisfies HandlerConfig;

type DeleteEntityVersionHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  versionId: SafeId<"entityVersion">;
  deletedByUserId: string;
  recordAuditEvent: AuditRecorder;
};

export const deleteEntityVersionHandler = async function* ({
  safeDb,
  workspaceId,
  entityId,
  versionId,
  deletedByUserId,
  recordAuditEvent,
}: DeleteEntityVersionHandlerProps) {
  const params = { entityId, versionId };

  // All validation (live-version count, current-version promotion) and the
  // tombstone mutation run in ONE transaction, serialized on the owning entity
  // row via `FOR UPDATE`. Two concurrent deletes must not each observe more
  // than one live version and tombstone the last two, nor leave
  // currentVersionId pointing at a tombstone: locking the entity row forces the
  // racing deletes to run one at a time, so the second re-reads the live count
  // and current version the first already changed.
  //
  // Canonical docx-edit lock order (issue #1139): docx-edit advisory lock ->
  // desktop_edit_session rows -> entities row. Acquire every target lock for
  // this version in stable order before checking room ownership. A concurrent
  // first join must therefore publish its room before this handler decides
  // whether the version can be tombstoned.
  const txOutcome = yield* Result.await(
    safeDb(async (tx) => {
      const targetProperties = await tx
        .select({ propertyId: fields.propertyId })
        .from(fields)
        .innerJoin(
          entityVersions,
          eq(fields.entityVersionId, entityVersions.id),
        )
        .where(
          and(
            eq(entityVersions.id, params.versionId),
            eq(entityVersions.entityId, params.entityId),
            eq(entityVersions.workspaceId, workspaceId),
          ),
        )
        .orderBy(asc(fields.propertyId))
        .limit(LIMITS.propertiesCount);
      for (const { propertyId } of targetProperties) {
        // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- ordered advisory-lock acquisition; a single statement guarantees no evaluation order
        await lockDocxEditTarget({
          entityId: params.entityId,
          propertyId,
          tx,
          workspaceId,
        });
      }

      // Lock every edit owner anchored to this version first, establishing the
      // edit-state -> entity order. Desktop sessions can be cancelled below;
      // durable collaboration rooms must instead block the tombstone so their
      // shared working state never loses its base.
      await tx
        .select({ id: desktopEditSessions.id })
        .from(desktopEditSessions)
        .where(
          and(
            eq(desktopEditSessions.baseVersionId, params.versionId),
            eq(desktopEditSessions.workspaceId, workspaceId),
            eq(desktopEditSessions.status, "open"),
          ),
        )
        .for("update");
      const collabRooms = await tx
        .select({ id: folioCollabRooms.id })
        .from(folioCollabRooms)
        .where(
          and(
            eq(folioCollabRooms.baseVersionId, params.versionId),
            eq(folioCollabRooms.workspaceId, workspaceId),
          ),
        )
        .for("update");

      const lockedEntityRows = await tx
        .select({
          currentVersionId: entities.currentVersionId,
          readOnly: entities.readOnly,
        })
        .from(entities)
        .where(
          and(
            eq(entities.id, params.entityId),
            eq(entities.workspaceId, workspaceId),
          ),
        )
        .for("update");
      const lockedEntity = lockedEntityRows.at(0);
      // entityVersions FKs to entities, so a versionId can only resolve when its
      // entity row exists; a missing entity here means the version is
      // unaddressable, which reads as a 404 rather than a structural panic.
      if (!lockedEntity) {
        return {
          ok: false as const,
          status: 404 as const,
          message: "Version not found",
        };
      }

      // Verify the version belongs to this entity in this workspace and is not
      // already tombstoned (re-deleting a tombstoned version is a no-op 404).
      // Read under the entity lock so the checks below see a stable snapshot.
      const version = await tx.query.entityVersions.findFirst({
        where: {
          id: { eq: params.versionId },
          entityId: { eq: params.entityId },
          workspaceId: { eq: workspaceId },
          deletedAt: { isNull: true },
        },
        columns: { id: true, versionNumber: true },
      });
      if (!version) {
        return {
          ok: false as const,
          status: 404 as const,
          message: "Version not found",
        };
      }
      if (collabRooms.at(0)) {
        return {
          ok: false as const,
          status: 409 as const,
          message:
            "Create a newer collaborative version before deleting this base version",
        };
      }

      // A worker locks this entity immediately before moving the same version's
      // OCR run to `running`. Refuse the tombstone while that dispatch owns the
      // fence; otherwise a successful delete could race a provider request for
      // bytes that have just been withdrawn.
      const runningOcrRuns = await tx
        .select({ id: documentProcessingRuns.id })
        .from(documentProcessingRuns)
        .where(
          and(
            eq(documentProcessingRuns.entityId, params.entityId),
            eq(documentProcessingRuns.entityVersionId, params.versionId),
            eq(documentProcessingRuns.workspaceId, workspaceId),
            eq(documentProcessingRuns.status, "running"),
          ),
        )
        .limit(1);
      if (runningOcrRuns.at(0)) {
        return {
          ok: false as const,
          status: 409 as const,
          message: "Wait for document processing to finish before deleting",
        };
      }

      // Count live (non-tombstoned) versions under the lock — can't delete the
      // last one.
      const liveVersions = await tx
        .select({ id: entityVersions.id })
        .from(entityVersions)
        .where(
          and(
            eq(entityVersions.entityId, params.entityId),
            eq(entityVersions.workspaceId, workspaceId),
            isNull(entityVersions.deletedAt),
          ),
        )
        .orderBy(desc(entityVersions.versionNumber))
        .limit(LIMITS.versionsPerEntity);
      if (liveVersions.length <= 1) {
        return {
          ok: false as const,
          status: 400 as const,
          message: "Cannot delete the only remaining version",
        };
      }

      if (lockedEntity.readOnly) {
        return {
          ok: false as const,
          status: 409 as const,
          message: "Entity is read-only",
        };
      }

      const isDeletingCurrent =
        lockedEntity.currentVersionId === params.versionId;

      // Chain-of-custody: a prior version is never hard-deleted, and its S3
      // objects are retained under legal hold. Tombstone the row (server clock
      // + actor) so every read / list / restore / download path excludes it
      // while the bytes and audit trail survive. The `fields` rows are
      // deliberately kept: they keep the version's files "referenced" so
      // unrelated cleanup paths cannot GC them.
      //
      // If tombstoning the current version, promote the next live version FIRST
      // (FK constraint on entities.currentVersionId is RESTRICT). The live-count
      // guard above guarantees at least one other non-tombstoned version exists.
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
              isNull(entityVersions.deletedAt),
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
          // The existing projection belongs to the withdrawn current version.
          // Remove it atomically with promotion; post-commit processing below
          // rebuilds the promoted version's projection.
          await tx
            .delete(searchDocuments)
            .where(
              and(
                eq(searchDocuments.entityId, params.entityId),
                eq(searchDocuments.workspaceId, workspaceId),
              ),
            );
          promotedVersionId = next.id;
        }
      }

      // Tombstone the version instead of deleting it. `fields` and S3 objects
      // stay; the row is hidden by the deletedAt filter on every read path.
      await tx
        .update(entityVersions)
        .set({ deletedAt: new Date(), deletedBy: deletedByUserId })
        .where(
          and(
            eq(entityVersions.id, params.versionId),
            eq(entityVersions.workspaceId, workspaceId),
          ),
        );

      // Withdraw desktop sessions in the same transaction so none can resume
      // from the tombstoned version. Durable collaboration rooms were rejected
      // above because they have no participant-owned close transition.
      const cancelledSessions = await tx
        .update(desktopEditSessions)
        .set({ status: "cancelled", closedAt: new Date() })
        .where(
          and(
            eq(desktopEditSessions.baseVersionId, params.versionId),
            eq(desktopEditSessions.workspaceId, workspaceId),
            eq(desktopEditSessions.status, "open"),
          ),
        )
        .returning({ id: desktopEditSessions.id });
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
      for (const session of cancelledSessions) {
        events.push({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
          resourceId: session.id,
          changes: { status: { old: "open", new: "cancelled" } },
          metadata: { reason: "base_version_tombstoned" },
        });
      }
      await recordAuditEvent(tx, events);

      return { ok: true as const, promotedVersionId };
    }),
  );

  if (!txOutcome.ok) {
    return Result.err(
      new HandlerError({
        status: txOutcome.status,
        message: txOutcome.message,
      }),
    );
  }

  const promotedVersionId = txOutcome.promotedVersionId;
  if (promotedVersionId !== null) {
    await processExtraction(params.entityId).catch((error: unknown) =>
      captureError(error, {
        entityId: params.entityId,
        versionId: promotedVersionId,
      }),
    );
  }

  broadcastWorkspaceResourceUpdated(
    workspaceId,
    resourceRef({ type: RESOURCE_TYPE.ENTITY, id: entityId }),
  );
  broadcastWorkspaceResourceSetUpdated(workspaceId, RESOURCE_TYPE.USER_FILE);

  return Result.ok({ deleted: true });
};

export default createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, user, recordAuditEvent }) {
    return yield* deleteEntityVersionHandler({
      safeDb,
      workspaceId,
      entityId: params.entityId,
      versionId: params.versionId,
      deletedByUserId: user.id,
      recordAuditEvent,
    });
  },
);

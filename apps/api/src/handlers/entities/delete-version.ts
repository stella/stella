import { panic, Result } from "better-result";
import { and, desc, eq, isNull, ne } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { desktopEditSessions, entities, entityVersions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { broadcast } from "@/api/lib/sse";

const paramsSchema = workspaceParams({
  entityId: tSafeId("entity"),
  versionId: tSafeId("entityVersion"),
});

const config = {
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

  // Verify the version belongs to this entity in this workspace and is not
  // already tombstoned (re-deleting a tombstoned version is a no-op 404).
  const version = yield* Result.await(
    safeDb((tx) =>
      tx.query.entityVersions.findFirst({
        where: {
          id: { eq: params.versionId },
          entityId: { eq: params.entityId },
          workspaceId: { eq: workspaceId },
          deletedAt: { isNull: true },
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

  // Count live (non-tombstoned) versions — can't delete the last one
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
            isNull(entityVersions.deletedAt),
          ),
        )
        .orderBy(desc(entityVersions.versionNumber))
        .limit(LIMITS.versionsPerEntity),
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
  // An entityVersion row was already found for this entityId+workspaceId and
  // entityVersions FKs to entities, so a missing entity here is a structural
  // invariant violation, not a writable/non-current entity.
  if (!entity) {
    panic("Entity missing for an existing entity version");
  }
  if (entity.readOnly) {
    return Result.err(
      new HandlerError({ status: 409, message: "Entity is read-only" }),
    );
  }

  const isDeletingCurrent = entity.currentVersionId === params.versionId;

  // Chain-of-custody: a prior version is never hard-deleted, and its S3 objects
  // are retained under legal hold. Tombstone the row (server clock + actor) so
  // every read / list / restore / download path excludes it while the bytes and
  // audit trail survive. The `fields` rows are deliberately kept: they keep the
  // version's files "referenced" so unrelated cleanup paths cannot GC them.
  yield* Result.await(
    safeDb(async (tx) => {
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

      // Cascade the withdrawal to any open desktop edit session anchored to this
      // version: without this an in-flight session could resume and re-download
      // the withdrawn version's bytes. Cancel them in the same transaction so
      // the tombstone and the session closure commit atomically. The resume-path
      // chokepoint (readVersionDocxTarget) is the class guard should a future
      // tombstone writer forget this step; closing here is the primary fix.
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
    }),
  );

  broadcast(workspaceId, {
    type: "invalidate-query",
    data: ["entities", workspaceId],
  });

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

import { Result } from "better-result";
import { and, desc, eq, isNull, ne } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  desktopEditSessions,
  entities,
  entityVersions,
  folioCollabSessions,
} from "@/api/db/schema";
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

  // All validation (live-version count, current-version promotion) and the
  // tombstone mutation run in ONE transaction, serialized on the owning entity
  // row via `FOR UPDATE`. Two concurrent deletes must not each observe more
  // than one live version and tombstone the last two, nor leave
  // currentVersionId pointing at a tombstone: locking the entity row forces the
  // racing deletes to run one at a time, so the second re-reads the live count
  // and current version the first already changed.
  //
  // Canonical docx-edit lock order (issue #1139): docx-edit advisory lock ->
  // desktop_edit_session rows -> entities row. This handler takes no advisory
  // lock, but it MUST lock the sessions it will cancel BEFORE the entity row so
  // it agrees with finalize-desktop-edit-session (which locks the session row,
  // then the entity row). Locking the entity first here and the sessions second
  // would invert finalize's order and risk an ABBA deadlock.
  const txOutcome = yield* Result.await(
    safeDb(async (tx) => {
      // Lock (not yet cancel) every open session anchored to this version first,
      // establishing the session -> entity order. Both session kinds anchor to a
      // base version (desktop_edit_sessions and folio_collab_sessions), so both
      // must be withdrawn when that version is tombstoned. The cancel UPDATEs
      // below re-touch these already-locked rows.
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
      await tx
        .select({ id: folioCollabSessions.id })
        .from(folioCollabSessions)
        .where(
          and(
            eq(folioCollabSessions.baseVersionId, params.versionId),
            eq(folioCollabSessions.workspaceId, workspaceId),
            eq(folioCollabSessions.status, "open"),
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

      // Cascade the withdrawal to every open edit session anchored to this
      // version: without this an in-flight session could resume/seed and
      // re-download the withdrawn version's bytes. Both session kinds anchor to
      // a base version, and the baseVersionId FK is `onDelete: cascade` — which
      // never fires here because we soft-delete (tombstone) rather than DELETE —
      // so each kind must be cancelled explicitly. Cancel them in the same
      // transaction so the tombstone and the closures commit atomically. The
      // resume-path chokepoint (readVersionDocxTarget) is the class guard for
      // desktop sessions should a future tombstone writer forget this step;
      // closing here is the primary fix for both kinds.
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
      const cancelledCollabSessions = await tx
        .update(folioCollabSessions)
        .set({ status: "cancelled", closedAt: new Date() })
        .where(
          and(
            eq(folioCollabSessions.baseVersionId, params.versionId),
            eq(folioCollabSessions.workspaceId, workspaceId),
            eq(folioCollabSessions.status, "open"),
          ),
        )
        .returning({ id: folioCollabSessions.id });

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
      for (const session of cancelledCollabSessions) {
        events.push({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_SESSION,
          resourceId: session.id,
          changes: { status: { old: "open", new: "cancelled" } },
          metadata: { reason: "base_version_tombstoned" },
        });
      }
      await recordAuditEvent(tx, events);

      return { ok: true as const };
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

import { Result } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import {
  documentProcessingRuns,
  entityDeletionCleanupRequests,
  entities,
  entityVersions,
  fields,
  folioCollabRooms,
  workspaces,
} from "@/api/db/schema";
import { entityFileRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { validateEntityRemovalState } from "@/api/lib/entities/entity-removal-state";
import { handoffCommittedEntityDeletionCleanupBatch } from "@/api/lib/entity-deletion-cleanup-handoff";
import { enqueueEntityDeletionCleanup } from "@/api/lib/entity-deletion-cleanup-queue";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  extractFieldFileRefs,
  filterUnreferencedFieldFileRefs,
} from "@/api/lib/files/field-file-refs";
import {
  createFileKey,
  createOcrSearchablePdfKey,
} from "@/api/lib/files/utils";
import {
  admitFlowReviewTaskDeletion,
  FLOW_TASK_FEATURE_ACCESS,
} from "@/api/lib/flows/review-gate-task";
import { collectFolioCollabStoredRoomFiles } from "@/api/lib/folio-collab-rooms";
import { LIMITS } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  forEachOcrDerivativePage,
  ocrDerivativeCursorFilter,
  ocrDerivativePageOrder,
} from "@/api/lib/ocr-derivative-pages";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";
import { getSearchMaintenance } from "@/api/lib/search/pg-fts-maintenance";

import { selectCanonicalFileContents } from "./delete-file-snapshot";

const searchRepairFailure = failureSink({
  event: "entities.delete_search_repair_failed",
  expected: [],
  legacy: { severity: "ERROR", capture: true },
});

const deleteEntitiesBodySchema = t.Object({
  entityIds: t.Array(tSafeId("entity"), {
    minItems: 1,
    maxItems: LIMITS.entitiesPageSizeMax,
  }),
});

type DeleteEntitiesBodySchema = Static<typeof deleteEntitiesBodySchema>;

export type DeleteEntitiesHandlerProps = {
  userId: SafeId<"user">;
  enqueueCleanup?: (
    requestId: SafeId<"entityDeletionCleanupRequest">,
  ) => Promise<void>;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: DeleteEntitiesBodySchema;
};

export const deleteEntitiesHandler = async function* ({
  enqueueCleanup = enqueueEntityDeletionCleanup,
  safeDb,
  organizationId,
  userId,
  workspaceId,
  recordAuditEvent,
  body,
}: DeleteEntitiesHandlerProps) {
  const txOutcome = yield* Result.await(
    safeDb(async (tx) => {
      const admission = await admitFlowReviewTaskDeletion(tx, {
        workspaceId,
        taskEntityIds: body.entityIds,
        userId,
      });
      if (admission.isErr()) {
        return { status: "rejected" as const, error: admission.error };
      }
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`,
      );
      const workspaceRows = await tx
        .select({ status: workspaces.status })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
        .for("update");
      if (workspaceRows.at(0)?.status !== "active") {
        return {
          status: "rejected" as const,
          error: new HandlerError({
            status: 409,
            message: "Workspace is not active",
          }),
        };
      }

      // Room pointer publication and version deletion both lock a room before
      // its entity. Follow that order so the cleanup request captures the last
      // committed snapshot pointer without introducing an inverse lock edge.
      const collabRooms = await tx
        .select({
          docxCheckpointFileId: folioCollabRooms.docxCheckpointFileId,
          docxCheckpointUpdatedAt: folioCollabRooms.docxCheckpointUpdatedAt,
          id: folioCollabRooms.id,
          yjsSnapshotFileId: folioCollabRooms.yjsSnapshotFileId,
          yjsSnapshotUpdatedAt: folioCollabRooms.yjsSnapshotUpdatedAt,
        })
        .from(folioCollabRooms)
        .where(
          and(
            eq(folioCollabRooms.workspaceId, workspaceId),
            inArray(folioCollabRooms.entityId, body.entityIds),
          ),
        )
        .orderBy(asc(folioCollabRooms.id))
        .limit(LIMITS.entitiesPageSizeMax * LIMITS.propertiesCount)
        .for("update");

      // OCR dispatch takes this same entity fence before changing a run to
      // `running`. The committed entity deletion is the durable withdrawal
      // fence; storage cleanup happens later from a durable request, never
      // while this transaction owns locks.
      const lockedEntities = await tx
        .select({
          currentVersionId: entities.currentVersionId,
          id: entities.id,
          readOnly: entities.readOnly,
        })
        .from(entities)
        .where(
          and(
            eq(entities.workspaceId, workspaceId),
            inArray(entities.id, body.entityIds),
          ),
        )
        .orderBy(asc(entities.id))
        .limit(LIMITS.entitiesPageSizeMax)
        .for("update");
      if (lockedEntities.some(({ readOnly }) => readOnly)) {
        return {
          status: "rejected" as const,
          error: new HandlerError({
            status: 409,
            message: "Entity is read-only",
          }),
        };
      }

      const removalState = await validateEntityRemovalState({
        tx,
        workspaceId,
        entityIds: body.entityIds,
        operation: "delete",
        now: new Date(),
      });
      if (removalState.isErr()) {
        return {
          status: "rejected" as const,
          error: removalState.error,
        };
      }

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

      const fieldRows = await tx
        .select({
          content: fields.content,
          entityVersionId: fields.entityVersionId,
          id: fields.id,
        })
        .from(fields)
        .where(inArray(fields.entityVersionId, entityVersionIds));

      const entityIdByCurrentVersionId = new Map(
        lockedEntities.flatMap(({ currentVersionId, id }) =>
          currentVersionId === null ? [] : [[currentVersionId, id] as const],
        ),
      );
      const currentFileByEntityId = selectCanonicalFileContents(
        fieldRows,
        entityIdByCurrentVersionId,
      );

      const fileRefs = fieldRows.flatMap((row) =>
        extractFieldFileRefs(row.content),
      );
      const unreferencedFileRefs = await filterUnreferencedFieldFileRefs({
        tx,
        workspaceId,
        fileRows: fileRefs,
        excludedEntityIds: body.entityIds,
      });

      // A long-lived document accumulates one OCR run per version and field,
      // so the derivative set is unbounded. Record it as bounded cleanup
      // request pages instead of capping how much a caller may delete.
      const cleanupRequestIds: SafeId<"entityDeletionCleanupRequest">[] = [];
      const recordCleanupRequest = async (s3Keys: string[]): Promise<void> => {
        if (s3Keys.length === 0) {
          return;
        }
        const cleanupRequestId = createSafeId<"entityDeletionCleanupRequest">();
        // audit: skip — outbox bookkeeping for the deletion this transaction
        // already audits; the request rows carry no user-visible state.
        await tx.insert(entityDeletionCleanupRequests).values({
          id: cleanupRequestId,
          organizationId,
          workspaceId,
          s3Keys,
        });
        cleanupRequestIds.push(cleanupRequestId);
      };

      await recordCleanupRequest(
        unreferencedFileRefs.map(({ fileId, mimeType }) =>
          createFileKey({ organizationId, workspaceId, fileId, mimeType }),
        ),
      );
      await recordCleanupRequest(
        collabRooms.flatMap((room) =>
          collectFolioCollabStoredRoomFiles(room).map(({ fileId, mimeType }) =>
            createFileKey({
              fileId,
              mimeType,
              organizationId,
              workspaceId,
            }),
          ),
        ),
      );
      await forEachOcrDerivativePage({
        readPage: async (cursor, limit) =>
          await tx
            .select({ id: documentProcessingRuns.id })
            .from(documentProcessingRuns)
            .where(
              and(
                eq(documentProcessingRuns.workspaceId, workspaceId),
                inArray(documentProcessingRuns.entityId, body.entityIds),
                ocrDerivativeCursorFilter(cursor),
              ),
            )
            .orderBy(...ocrDerivativePageOrder())
            .limit(limit),
        onPage: async (runs) =>
          await recordCleanupRequest(
            runs.map(({ id }) =>
              createOcrSearchablePdfKey({
                organizationId,
                workspaceId,
                runId: id,
              }),
            ),
          ),
      });

      // Cascade: entities → entityVersions → fields →
      // justifications (all cascade).
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
        deleted.map((entity) => {
          const file = currentFileByEntityId.get(entity.id);
          return {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
            resourceId: entity.id,
            changes: {
              deleted: {
                old: {
                  kind: entity.kind,
                  name: entity.name,
                  parentId: entity.parentId,
                  ...(file
                    ? {
                        fileName: sanitizeFilename(file.fileName),
                        mimeType: file.mimeType,
                      }
                    : {}),
                },
                new: null,
              },
            },
          };
        }),
      );

      return {
        status: "deleted" as const,
        cleanupRequestIds,
        entities: deleted,
      };
    }),
  );
  if (txOutcome.status === "rejected") {
    return Result.err(txOutcome.error);
  }
  const deletedEntities = txOutcome.entities;
  // Accelerate only a bounded prefix. The requests are already committed and
  // the reconciler claims every `pending` row on its own schedule, so a
  // deletion that produced many pages must not fan out an unbounded number of
  // queue calls or hold its response open behind the slowest one.
  await handoffCommittedEntityDeletionCleanupBatch({
    captureDeliveryError: captureError,
    enqueueCleanup,
    requestIds: txOutcome.cleanupRequestIds,
  });

  // Explicit removal for non-PG providers (CASCADE handles PG)
  for (const entity of deletedEntities) {
    Result.tryPromise(
      async () =>
        await safeDb(
          async (tx) =>
            await getSearchMaintenance(tx, upsertSearchDocument).removeEntity({
              entityId: entity.id,
              workspaceId,
            }),
        ),
    ).then((searchAttempt) => {
      const result = searchAttempt.andThen((value) => value);
      if (result.isErr()) {
        observeFailure(result.error, { sink: searchRepairFailure });
      }
      return result;
    });
  }

  return Result.ok({});
};

const config = {
  description:
    "Permanently delete documents, folders, or tasks from one matter, together " +
    "with their versions, field values, and stored files. Refused while any of " +
    "them is read-only or has a document-processing run in flight; unlike " +
    "entities.versions.delete this is a real delete, not a tombstone.",
  permissions: { entity: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: FLOW_TASK_FEATURE_ACCESS,
  realtime: entityFileRealtimeUpdates,
  mcp: { type: "tool", name: "delete_document" },
  body: deleteEntitiesBodySchema,
} satisfies WorkspaceHandlerConfig;

const deleteEntities = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    workspaceId,
    body,
    recordAuditEvent,
    user,
  }) {
    return yield* deleteEntitiesHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default deleteEntities;

import { panic, Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { transactionAbortError } from "@/api/db/safe-db";
import type { FieldContent } from "@/api/db/schema-validators";
import {
  collectFileCopySources,
  copyEntities,
  type CopyEntitiesDependencies,
  copyFileObjects,
  CURRENT_VERSION_SELECT,
  ENTITY_SNAPSHOT_COLUMNS,
  type EntitySnapshot,
  getFolderSubtree,
  remapFileIds,
  rollbackS3Copies,
  snapshotOfCurrentVersion,
} from "@/api/handlers/entities/copy-utils";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { enqueueDocumentProcessingRun } from "@/api/lib/document-processing-enqueue";
import { handoffCommittedDocumentProcessingRuns } from "@/api/lib/document-processing-handoff";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import { LIMITS } from "@/api/lib/limits";
import {
  requestNativeExtractionRuns,
  SEARCH_INDEX_OWNER,
} from "@/api/lib/search/process-extraction";
import {
  enqueueEntitySearchRepairs,
  flushEntitySearchRepairs,
} from "@/api/lib/search/projection-repair-queue";

const duplicateEntityBodySchema = t.Object({
  entityId: tSafeId("entity"),
  name: t.Optional(
    t.String({ minLength: 1, maxLength: LIMITS.entityNameMaxLength }),
  ),
  targetEntityId: t.Optional(tSafeId("entity")),
});

type DuplicateEntityHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof duplicateEntityBodySchema>;
  dependencies: DuplicateEntityDependencies;
};

type DuplicateReplay = {
  id: SafeId<"entity">;
  name: string;
  currentVersion: {
    fields: { id: SafeId<"field">; content: FieldContent }[];
  } | null;
};

const duplicateReplayPayload = ({
  id,
  name,
  currentVersion,
}: DuplicateReplay) => {
  const version = currentVersion ?? panic("Duplicate has no current version");
  const fileField = version.fields.find(
    ({ content }) => content.type === "file",
  );
  return { entityId: id, fieldId: fileField?.id ?? null, name };
};

export type DuplicateEntityDependencies = CopyEntitiesDependencies & {
  enqueueDocumentProcessingRun: typeof enqueueDocumentProcessingRun;
  flushEntitySearchRepairs: typeof flushEntitySearchRepairs;
};

const defaultDuplicateEntityDependencies = {
  enqueueDocumentProcessingRun,
  enqueueEntitySearchRepairs,
  flushEntitySearchRepairs,
  requestNativeExtractionRuns,
} satisfies DuplicateEntityDependencies;

const duplicateEntityHandler = async function* ({
  safeDb,
  organizationId,
  workspaceId,
  userId,
  recordAuditEvent,
  body: { entityId: sourceEntityId, name, targetEntityId },
  dependencies,
}: DuplicateEntityHandlerProps) {
  const source = yield* Result.await(
    safeDb(async (tx) => {
      const entity = await tx.query.entities.findFirst({
        where: { id: { eq: sourceEntityId }, workspaceId: { eq: workspaceId } },
        columns: ENTITY_SNAPSHOT_COLUMNS,
        with: CURRENT_VERSION_SELECT,
      });
      return entity && snapshotOfCurrentVersion(entity);
    }),
  );

  if (!source) {
    return Result.err(
      new HandlerError({ status: 404, message: "Entity not found" }),
    );
  }

  const findReplay = async (replayTargetEntityId: SafeId<"entity">) =>
    await safeDb(
      async (tx) =>
        await tx.query.entities.findFirst({
          where: {
            id: { eq: replayTargetEntityId },
            workspaceId: { eq: workspaceId },
            createdBy: { eq: userId },
            duplicateSourceEntityId: { eq: sourceEntityId },
          },
          columns: { id: true, name: true },
          with: {
            currentVersion: {
              columns: { id: true },
              with: {
                fields: {
                  columns: { id: true, content: true },
                  orderBy: { id: "asc" },
                  limit: LIMITS.propertiesCount,
                },
              },
            },
          },
        }),
    );
  if (targetEntityId) {
    const replayed = yield* Result.await(findReplay(targetEntityId));
    if (replayed) {
      return Result.ok(duplicateReplayPayload(replayed));
    }
  }

  let sourceEntities: EntitySnapshot[] = [source];
  if (source.kind === "folder") {
    const workspaceEntities = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx.query.entities.findMany({
          where: { workspaceId: { eq: workspaceId } },
          columns: ENTITY_SNAPSHOT_COLUMNS,
          with: CURRENT_VERSION_SELECT,
          limit: LIMITS.entitiesCount,
        });
        return rows.map(snapshotOfCurrentVersion);
      }),
    );

    const subtree = getFolderSubtree(workspaceEntities, sourceEntityId);
    if (!subtree) {
      return Result.err(
        new HandlerError({ status: 404, message: "Entity not found" }),
      );
    }

    sourceEntities = subtree;
  }

  const fileCopySources = collectFileCopySources({
    sourceEntities,
    organizationId,
    sourceWorkspaceId: workspaceId,
  });

  const copiedS3Keys: string[] = [];
  const fileMappings = await copyFileObjects({
    sources: fileCopySources,
    organizationId,
    targetWorkspaceId: workspaceId,
    copiedS3Keys,
  });
  if (Result.isError(fileMappings)) {
    await rollbackS3Copies(copiedS3Keys);
    captureError(fileMappings.error, { workspaceId, sourceEntityId });
    return Result.err(
      new HandlerError({ status: 500, message: "Failed to copy files" }),
    );
  }

  const remappedEntities = remapFileIds(sourceEntities, fileMappings.value);

  const txResultResult = (
    await safeDb(
      async (tx) =>
        await copyEntities({
          organizationId,
          tx,
          targetWorkspaceId: workspaceId,
          targetParentId: source.parentId,
          userId,
          recordAuditEvent,
          sourceEntityId,
          sourceEntities: remappedEntities,
          targetRootEntityId: targetEntityId,
          targetRootName: name,
          // A duplicate is a new document in the same matter: its own
          // version 1, its own stamp and code.
          transfer: { type: "copy" },
          fieldMapping: { type: "omit" },
          dependencies,
        }),
    )
  )
    .mapError(transactionAbortError)
    .andThen((copied) => copied);

  if (Result.isError(txResultResult)) {
    if (targetEntityId) {
      const replayed = await findReplay(targetEntityId);
      if (Result.isError(replayed)) {
        // The transaction outcome and the ownership of its objects are both
        // unknown. Retain them until a replay can prove whether they are
        // referenced; deleting here could corrupt a committed duplicate.
        return Result.err(txResultResult.error);
      }
      if (replayed.value) {
        return Result.ok(duplicateReplayPayload(replayed.value));
      }
    }
    // The transaction is confirmed absent, so every copied object is orphaned.
    await rollbackS3Copies(copiedS3Keys);
    return Result.err(txResultResult.error);
  }

  const txResult = txResultResult.value;

  // Acceleration only: the marks are already committed, and the standing
  // drain repairs whatever a lost flush leaves behind.
  dependencies
    .flushEntitySearchRepairs(
      txResult.entityIdsBySearchIndexOwner[SEARCH_INDEX_OWNER.searchMark],
    )
    .catch(captureError);

  handoffCommittedDocumentProcessingRuns({
    enqueue: dependencies.enqueueDocumentProcessingRun,
    runIds: txResult.nativeExtractionRunIds,
  }).catch(captureError);

  // The copies reference fresh file IDs, so each needs its own
  // PDF/thumbnail derivatives.
  for (const fileField of txResult.fileFields) {
    enqueuePdfDerivativeOrMarkFailed({
      entityId: fileField.entityId,
      fieldId: fileField.fieldId,
      mimeType: fileField.mimeType,
      encrypted: fileField.encrypted,
      organizationId,
      userId,
      workspaceId,
    }).catch(captureError);
    enqueueImageThumbnailOrMarkFailed({
      entityId: fileField.entityId,
      fieldId: fileField.fieldId,
      mimeType: fileField.mimeType,
      encrypted: fileField.encrypted,
      organizationId,
      userId,
      workspaceId,
    }).catch(captureError);
  }

  return Result.ok({
    entityId: txResult.entityId,
    fieldId:
      txResult.fileFields.find(({ entityId }) => entityId === txResult.entityId)
        ?.fieldId ?? null,
    name:
      txResult.copiedEntities.find(
        ({ entityId }) => entityId === txResult.entityId,
      )?.name ?? panic("Duplicate root was not returned"),
  });
};

const config = {
  description:
    "Copy one document, or a folder with its whole subtree, inside the same " +
    "matter, placing the copy alongside the original. Stored files are " +
    "copied too, so the copies own their own bytes and get their own text " +
    "extraction and PDF and thumbnail derivatives. Use " +
    "entities.copy to copy into a different matter.",
  permissions: { entity: ["create"] },
  mcp: { type: "capability", reason: "document_processing" },
  body: duplicateEntityBodySchema,
} satisfies WorkspaceHandlerConfig;

export const createDuplicateEntity = (
  dependencies: DuplicateEntityDependencies = defaultDuplicateEntityDependencies,
) =>
  createSafeHandler(
    config,
    async function* ({
      safeDb,
      session,
      user,
      workspaceId,
      body,
      recordAuditEvent,
    }) {
      return yield* duplicateEntityHandler({
        safeDb,
        organizationId: session.activeOrganizationId,
        workspaceId,
        userId: user.id,
        recordAuditEvent,
        body,
        dependencies,
      });
    },
  );

const duplicateEntity = createDuplicateEntity();

export default duplicateEntity;

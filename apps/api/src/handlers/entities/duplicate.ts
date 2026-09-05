import { Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { transactionAbortError } from "@/api/db/safe-db";
import {
  collectFileCopySources,
  copyEntities,
  type CopyEntitiesDependencies,
  copyFileObjects,
  type EntitySnapshot,
  type FileMapping,
  getFolderSubtree,
  remapFileIds,
  rollbackS3Copies,
} from "@/api/handlers/entities/copy-utils";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
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
  body: { entityId: sourceEntityId },
  dependencies,
}: DuplicateEntityHandlerProps) {
  const source = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findFirst({
        where: { id: { eq: sourceEntityId }, workspaceId: { eq: workspaceId } },
        columns: {
          id: true,
          kind: true,
          name: true,
          parentId: true,
        },
        with: {
          currentVersion: {
            columns: { id: true },
            with: {
              // Ascending field id is ascending creation order, the order
              // `findExtractionFileField` requires, so the copy resolves the
              // same extraction source as the entity it came from. At most
              // one field per property bounds the read.
              fields: {
                columns: {
                  propertyId: true,
                  content: true,
                },
                orderBy: { id: "asc" },
                limit: LIMITS.propertiesCount,
              },
            },
          },
        },
      }),
    ),
  );

  if (!source) {
    return Result.err(
      new HandlerError({ status: 404, message: "Entity not found" }),
    );
  }

  let sourceEntities: EntitySnapshot[] = [source];
  if (source.kind === "folder") {
    const workspaceEntities = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findMany({
          where: { workspaceId: { eq: workspaceId } },
          columns: {
            id: true,
            kind: true,
            name: true,
            parentId: true,
          },
          with: {
            currentVersion: {
              columns: { id: true },
              with: {
                fields: {
                  columns: {
                    propertyId: true,
                    content: true,
                  },
                  orderBy: { id: "asc" },
                  limit: LIMITS.propertiesCount,
                },
              },
            },
          },
          limit: LIMITS.entitiesCount,
        }),
      ),
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
  let fileMappings: FileMapping[];

  try {
    fileMappings = await copyFileObjects({
      sources: fileCopySources,
      organizationId,
      targetWorkspaceId: workspaceId,
      copiedS3Keys,
    });
  } catch (error) {
    await rollbackS3Copies(copiedS3Keys);
    captureError(error, { workspaceId, sourceEntityId });
    return Result.err(
      new HandlerError({ status: 500, message: "Failed to copy files" }),
    );
  }

  const remappedEntities = remapFileIds(sourceEntities, fileMappings);

  const txResultResult = await safeDb(
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
        // Same-workspace duplicate never deletes the source; the
        // lock set is target-only regardless (see `copyEntities`).
        deleteSource: false,
        dependencies,
      }),
  );

  // An aborted copy leaves no rows, so every object copied for it is an
  // orphan and the whole set goes back.
  if (Result.isError(txResultResult)) {
    await rollbackS3Copies(copiedS3Keys);
    return Result.err(transactionAbortError(txResultResult.error));
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

  return Result.ok({ entityId: txResult.entityId });
};

const config = {
  description:
    "Copy one document, or a folder with its whole subtree, inside the same " +
    "matter, placing the copy alongside the original. Stored files are " +
    "copied too, so the copies own their own bytes and get their own text " +
    "extraction and PDF and thumbnail derivatives. Use " +
    "entities.copy-to-matter to copy into a different matter.",
  permissions: { entity: ["create"] },
  mcp: { type: "capability", reason: "document_processing" },
  body: duplicateEntityBodySchema,
} satisfies HandlerConfig;

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

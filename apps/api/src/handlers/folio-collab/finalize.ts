import { panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import {
  entities,
  entityVersions,
  fields,
  folioCollabSessions,
  workspaces,
} from "@/api/db/schema";
import { computeVersionDiffStats } from "@/api/handlers/entities/compute-version-diff";
import { findDocxFieldForProperty } from "@/api/handlers/entities/desktop-edit-session-utils";
import { validateDocxBuffer } from "@/api/handlers/entities/validate-docx-buffer";
import {
  buildVersionStamp,
  cloneFieldsForRevision,
} from "@/api/handlers/entities/version-utils";
import { pdfDerivativeStateForFile } from "@/api/handlers/files/gotenberg";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { enqueuePdfDerivativeOrMarkFailed } from "@/api/lib/file-derivative-queue";
import { authorizeFolioCollabSession } from "@/api/lib/folio-collab-sessions";
import { getS3 } from "@/api/lib/s3";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { broadcast } from "@/api/lib/sse";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export const finalizeFolioCollabSessionParamsSchema = t.Object({
  sessionId: tSafeId("folioCollabSession"),
});

export const finalizeFolioCollabSessionBodySchema = t.Object({
  token: t.String({ minLength: 64, maxLength: 64 }),
});

type FinalizeFolioCollabSessionHandlerProps = {
  body: Static<typeof finalizeFolioCollabSessionBodySchema>;
  sessionId: SafeId<"folioCollabSession">;
};

export const finalizeFolioCollabSessionHandler = async ({
  body: { token },
  sessionId,
}: FinalizeFolioCollabSessionHandlerProps) => {
  const authorizedSession = await authorizeFolioCollabSession({
    sessionId,
    token,
  });

  if (authorizedSession.status === "missing") {
    return status(404, { message: "Collaborative edit session not found." });
  }

  if (authorizedSession.status === "token-expired") {
    return status(401, { message: "Collaborative edit token expired." });
  }

  if (authorizedSession.status === "permission-revoked") {
    return status(403, { message: "Collaborative edit permission revoked." });
  }

  if (!authorizedSession.value.canEdit) {
    return status(403, { message: "Collaborative edit is read-only." });
  }

  const { organizationId, scopedDb, userId, workspaceId } =
    authorizedSession.value;

  const deleteS3Key = async (key: string, context: Record<string, string>) => {
    await getS3()
      .delete(key)
      .catch((error: unknown) => {
        captureError(error, context);
      });
  };

  // Phase A: non-locking read. entity_versions rows are immutable
  // once written, so reading the base version outside the heavy
  // write txn is safe; the session row may move under us, but we
  // re-verify inside the write txn before we commit any rows.
  const sessionPreview = await scopedDb(async (tx) => {
    const rows = await tx
      .select({
        baseVersionId: folioCollabSessions.baseVersionId,
        docxCheckpointFileId: folioCollabSessions.docxCheckpointFileId,
        docxCheckpointScanWarnings:
          folioCollabSessions.docxCheckpointScanWarnings,
        docxCheckpointSha256Hex: folioCollabSessions.docxCheckpointSha256Hex,
        docxCheckpointSizeBytes: folioCollabSessions.docxCheckpointSizeBytes,
        docxCheckpointUpdatedAt: folioCollabSessions.docxCheckpointUpdatedAt,
        entityId: folioCollabSessions.entityId,
        fileName: folioCollabSessions.fileName,
        propertyId: folioCollabSessions.propertyId,
        status: folioCollabSessions.status,
      })
      .from(folioCollabSessions)
      .where(
        and(
          eq(folioCollabSessions.id, sessionId),
          eq(folioCollabSessions.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return rows.at(0);
  });

  if (!sessionPreview) {
    return status(404, { message: "Collaborative edit session not found." });
  }

  if (sessionPreview.status !== "open") {
    return status(409, {
      message: "Collaborative edit session is already closed.",
    });
  }

  const checkpointSha256Hex = sessionPreview.docxCheckpointSha256Hex;
  const checkpointSizeBytes = sessionPreview.docxCheckpointSizeBytes;
  if (
    checkpointSha256Hex === null ||
    checkpointSizeBytes === null ||
    sessionPreview.docxCheckpointUpdatedAt === null
  ) {
    await scopedDb(async (tx) => {
      await tx
        .update(folioCollabSessions)
        .set({ closedAt: new Date(), status: "cancelled" })
        .where(eq(folioCollabSessions.id, sessionId));
    });
    return { outcome: "no_changes" } as const;
  }

  const checkpointKey = createFileKey({
    fileId: sessionPreview.docxCheckpointFileId,
    mimeType: DOCX_MIME_TYPE,
    organizationId,
    workspaceId,
  });

  const baseVersion = await scopedDb(
    async (tx) =>
      await tx.query.entityVersions.findFirst({
        where: {
          entityId: { eq: sessionPreview.entityId },
          id: { eq: sessionPreview.baseVersionId },
          workspaceId: { eq: workspaceId },
        },
        columns: { versionNumber: true },
        with: {
          fields: { columns: { content: true, propertyId: true } },
        },
      }),
  );

  if (!baseVersion) {
    return status(409, { message: "Base entity version not found." });
  }

  const baseFileField = findDocxFieldForProperty({
    fieldEntries: baseVersion.fields,
    propertyId: sessionPreview.propertyId,
  });

  if (!baseFileField) {
    return status(409, {
      message: "Collaborative edit session source file is no longer available.",
    });
  }

  if (checkpointSha256Hex === baseFileField.sha256Hex) {
    await scopedDb(async (tx) => {
      await tx
        .update(folioCollabSessions)
        .set({ closedAt: new Date(), status: "cancelled" })
        .where(eq(folioCollabSessions.id, sessionId));
    });
    await deleteS3Key(checkpointKey, { checkpointKey, sessionId });
    return { outcome: "no_changes" } as const;
  }

  // Phase B: heavy IO + DOCX validation, all OUTSIDE the txn. The
  // source bytes are written to S3 before we open the txn; any
  // commit failure rolls them back via uploadedKeys.
  const checkpointBuffer = await getS3().file(checkpointKey).arrayBuffer();
  const validation = await validateDocxBuffer(checkpointBuffer);
  if (!validation.valid) {
    return status(422, {
      message: `Document validation failed: ${validation.error}`,
    });
  }

  const storedBytes = new Uint8Array(checkpointBuffer);
  const nextVersionNumber = baseVersion.versionNumber + 1;
  const nextVersionId = createSafeId<"entityVersion">();
  const sourceFileId = Bun.randomUUIDv7();
  const sourceKey = createFileKey({
    fileId: sourceFileId,
    mimeType: DOCX_MIME_TYPE,
    organizationId,
    workspaceId,
  });
  const uploadedKeys: string[] = [sourceKey];
  let shouldRollbackUploadedKeys = true;
  const rollbackUploadedKeys = async () => {
    await Promise.all(
      uploadedKeys.map(
        async (key) => await deleteS3Key(key, { rollbackKey: key, sessionId }),
      ),
    );
  };

  try {
    await getS3().write(sourceKey, storedBytes);

    // Phase C: txn — lock + verify state hasn't drifted + write rows.
    const result = await scopedDb(async (tx) => {
      const lockedSessions = await tx
        .select({
          docxCheckpointSha256Hex: folioCollabSessions.docxCheckpointSha256Hex,
          status: folioCollabSessions.status,
        })
        .from(folioCollabSessions)
        .where(
          and(
            eq(folioCollabSessions.id, sessionId),
            eq(folioCollabSessions.workspaceId, workspaceId),
          ),
        )
        .for("update");

      const editSession = lockedSessions.at(0);
      if (!editSession) {
        return {
          error: {
            message: "Collaborative edit session not found.",
            statusCode: 404,
          },
        } as const;
      }
      if (editSession.status !== "open") {
        return {
          error: {
            message: "Collaborative edit session is already closed.",
            statusCode: 409,
          },
        } as const;
      }
      if (editSession.docxCheckpointSha256Hex !== checkpointSha256Hex) {
        return {
          error: {
            message: "Collaborative edit checkpoint changed during finalize.",
            statusCode: 409,
          },
        } as const;
      }

      const lockedEntities = await tx
        .select({
          currentVersionId: entities.currentVersionId,
          docSequence: entities.docSequence,
        })
        .from(entities)
        .where(
          and(
            eq(entities.id, sessionPreview.entityId),
            eq(entities.workspaceId, workspaceId),
          ),
        )
        .for("update");

      const entity = lockedEntities.at(0);
      if (!entity) {
        return {
          error: { message: "Entity not found.", statusCode: 404 },
        } as const;
      }

      if (entity.currentVersionId !== sessionPreview.baseVersionId) {
        await tx
          .update(folioCollabSessions)
          .set({ closedAt: new Date(), status: "cancelled" })
          .where(eq(folioCollabSessions.id, sessionId));

        return {
          deleteCheckpoint: true,
          error: {
            message:
              "This document changed in Stella while collaborative editing was open.",
            statusCode: 409,
          },
        } as const;
      }

      const workspace = await tx.query.workspaces.findFirst({
        where: { id: { eq: workspaceId } },
        columns: { reference: true },
      });

      const nextVersionStamp = buildVersionStamp({
        docSequence: entity.docSequence,
        versionNumber: nextVersionNumber,
        workspaceReference:
          workspace?.reference ??
          panic("Workspace not found for finalized collaborative edit session"),
      });

      await tx.insert(entityVersions).values({
        entityId: sessionPreview.entityId,
        id: nextVersionId,
        stamp: nextVersionStamp.stamp,
        verificationCode: nextVersionStamp.verificationCode,
        versionNumber: nextVersionNumber,
        workspaceId,
      });

      const clonedFields = cloneFieldsForRevision({
        currentFields: baseVersion.fields,
        entityVersionId: nextVersionId,
        propertyId: sessionPreview.propertyId,
        replacementContent: {
          encrypted: false,
          fileName: sessionPreview.fileName,
          id: sourceFileId,
          mimeType: DOCX_MIME_TYPE,
          pdfFileId: null,
          pdfDerivative: pdfDerivativeStateForFile({
            encrypted: false,
            mimeType: DOCX_MIME_TYPE,
          }),
          sha256Hex: checkpointSha256Hex,
          sizeBytes: checkpointSizeBytes,
          type: "file",
          version: 1,
          ...(sessionPreview.docxCheckpointScanWarnings !== null && {
            scanWarnings: sessionPreview.docxCheckpointScanWarnings,
          }),
        },
        workspaceId,
      });

      const insertedFields = await tx
        .insert(fields)
        .values(clonedFields)
        .returning({ id: fields.id, propertyId: fields.propertyId });

      const nextField = insertedFields.find(
        (field) => field.propertyId === sessionPreview.propertyId,
      );

      await tx
        .update(entities)
        .set({
          currentVersionId: nextVersionId,
          lastEditedBy: userId,
          updatedAt: new Date(),
        })
        .where(eq(entities.id, sessionPreview.entityId));

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, workspaceId));

      await tx
        .update(folioCollabSessions)
        .set({
          closedAt: new Date(),
          finalizedVersionId: nextVersionId,
          status: "finalized",
        })
        .where(eq(folioCollabSessions.id, sessionId));

      return {
        entityId: sessionPreview.entityId,
        fieldId:
          nextField?.id ??
          panic("Finalized collaborative edit session field was not inserted"),
        outcome: "finalized",
        versionId: nextVersionId,
        versionNumber: nextVersionNumber,
      } as const;
    });

    if ("error" in result) {
      await rollbackUploadedKeys();
      if ("deleteCheckpoint" in result) {
        await deleteS3Key(checkpointKey, { checkpointKey, sessionId });
      }
      return status(result.error.statusCode, { message: result.error.message });
    }

    shouldRollbackUploadedKeys = false;
    await deleteS3Key(checkpointKey, { checkpointKey, sessionId });

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["entities", workspaceId],
    });

    await processCollaborativeEditDerivatives({
      entityId: result.entityId,
      fieldId: result.fieldId,
      organizationId,
      scopedDb,
      userId,
      versionId: result.versionId,
      workspaceId,
    });

    return result;
  } catch (error) {
    if (shouldRollbackUploadedKeys) {
      await rollbackUploadedKeys();
    }
    throw error;
  }
};

type ProcessCollaborativeEditDerivativesProps = {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  scopedDb: Parameters<typeof computeVersionDiffStats>[0]["scopedDb"];
  userId: SafeId<"user">;
  versionId: SafeId<"entityVersion">;
  workspaceId: SafeId<"workspace">;
};

const processCollaborativeEditDerivatives = async ({
  entityId,
  fieldId,
  organizationId,
  scopedDb,
  userId,
  versionId,
  workspaceId,
}: ProcessCollaborativeEditDerivativesProps) => {
  await processExtraction(entityId).catch((error: unknown) => {
    captureError(error, { entityId });
  });

  enqueuePdfDerivativeOrMarkFailed({
    encrypted: false,
    entityId,
    fieldId,
    mimeType: DOCX_MIME_TYPE,
    organizationId,
    userId,
    workspaceId,
  }).catch((error: unknown) => {
    captureError(error, { entityId, fieldId, mimeType: DOCX_MIME_TYPE });
  });

  computeVersionDiffStats({
    entityId,
    organizationId,
    scopedDb,
    versionId,
    workspaceId,
  }).catch((error: unknown) => {
    captureError(error, { versionId });
  });
};

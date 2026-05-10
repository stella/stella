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

  const uploadedKeys: string[] = [];
  let checkpointKeyToDelete: string | null = null;
  let shouldRollbackUploadedKeys = true;

  const deleteCheckpointKey = async (checkpointKey: string) => {
    await getS3()
      .delete(checkpointKey)
      .catch((error: unknown) => {
        captureError(error, { checkpointKey, sessionId });
      });
  };

  const deleteUploadedKey = async (uploadedKey: string) => {
    await getS3()
      .delete(uploadedKey)
      .catch((error: unknown) => {
        captureError(error, { rollbackKey: uploadedKey, sessionId });
      });
  };

  try {
    const result = await authorizedSession.value.scopedDb(async (tx) => {
      const lockedSessions = await tx
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
          id: folioCollabSessions.id,
          propertyId: folioCollabSessions.propertyId,
          status: folioCollabSessions.status,
        })
        .from(folioCollabSessions)
        .where(
          and(
            eq(folioCollabSessions.id, sessionId),
            eq(
              folioCollabSessions.workspaceId,
              authorizedSession.value.workspaceId,
            ),
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

      if (
        editSession.docxCheckpointSha256Hex === null ||
        editSession.docxCheckpointSizeBytes === null ||
        editSession.docxCheckpointUpdatedAt === null
      ) {
        await tx
          .update(folioCollabSessions)
          .set({ closedAt: new Date(), status: "cancelled" })
          .where(eq(folioCollabSessions.id, editSession.id));

        return { outcome: "no_changes" } as const;
      }

      const lockedEntities = await tx
        .select({
          currentVersionId: entities.currentVersionId,
          docSequence: entities.docSequence,
          id: entities.id,
        })
        .from(entities)
        .where(
          and(
            eq(entities.id, editSession.entityId),
            eq(entities.workspaceId, authorizedSession.value.workspaceId),
          ),
        )
        .for("update");

      const entity = lockedEntities.at(0);
      if (!entity) {
        return {
          error: { message: "Entity not found.", statusCode: 404 },
        } as const;
      }

      const checkpointKey = createFileKey({
        fileId: editSession.docxCheckpointFileId,
        mimeType: DOCX_MIME_TYPE,
        organizationId: authorizedSession.value.organizationId,
        workspaceId: authorizedSession.value.workspaceId,
      });

      if (entity.currentVersionId !== editSession.baseVersionId) {
        await tx
          .update(folioCollabSessions)
          .set({ closedAt: new Date(), status: "cancelled" })
          .where(eq(folioCollabSessions.id, editSession.id));

        checkpointKeyToDelete = checkpointKey;

        return {
          error: {
            message:
              "This document changed in Stella while collaborative editing was open.",
            statusCode: 409,
          },
        } as const;
      }

      const baseVersion = await tx.query.entityVersions.findFirst({
        where: {
          entityId: { eq: editSession.entityId },
          id: { eq: editSession.baseVersionId },
          workspaceId: { eq: authorizedSession.value.workspaceId },
        },
        columns: { versionNumber: true },
        with: {
          fields: { columns: { content: true, propertyId: true } },
        },
      });

      if (!baseVersion) {
        return {
          error: {
            message: "Base entity version not found.",
            statusCode: 409,
          },
        } as const;
      }

      const baseFileField = findDocxFieldForProperty({
        fieldEntries: baseVersion.fields,
        propertyId: editSession.propertyId,
      });

      if (!baseFileField) {
        return {
          error: {
            message:
              "Collaborative edit session source file is no longer available.",
            statusCode: 409,
          },
        } as const;
      }

      if (editSession.docxCheckpointSha256Hex === baseFileField.sha256Hex) {
        await tx
          .update(folioCollabSessions)
          .set({ closedAt: new Date(), status: "cancelled" })
          .where(eq(folioCollabSessions.id, editSession.id));

        checkpointKeyToDelete = checkpointKey;

        return { outcome: "no_changes" } as const;
      }

      const checkpointBuffer = await getS3().file(checkpointKey).arrayBuffer();
      const validation = await validateDocxBuffer(checkpointBuffer);
      if (!validation.valid) {
        return {
          error: {
            message: `Document validation failed: ${validation.error}`,
            statusCode: 422 as const,
          },
        } as const;
      }

      const nextVersionNumber = baseVersion.versionNumber + 1;
      const workspace = await tx.query.workspaces.findFirst({
        where: { id: { eq: authorizedSession.value.workspaceId } },
        columns: { reference: true },
      });

      const nextVersionStamp = buildVersionStamp({
        docSequence: entity.docSequence,
        versionNumber: nextVersionNumber,
        workspaceReference:
          workspace?.reference ??
          panic("Workspace not found for finalized collaborative edit session"),
      });

      const storedBytes = new Uint8Array(checkpointBuffer);
      const nextVersionId = createSafeId<"entityVersion">();
      const sourceFileId = Bun.randomUUIDv7();
      const sourceKey = createFileKey({
        fileId: sourceFileId,
        mimeType: DOCX_MIME_TYPE,
        organizationId: authorizedSession.value.organizationId,
        workspaceId: authorizedSession.value.workspaceId,
      });
      uploadedKeys.push(sourceKey);

      await getS3().write(sourceKey, storedBytes);

      await tx.insert(entityVersions).values({
        entityId: editSession.entityId,
        id: nextVersionId,
        stamp: nextVersionStamp.stamp,
        verificationCode: nextVersionStamp.verificationCode,
        versionNumber: nextVersionNumber,
        workspaceId: authorizedSession.value.workspaceId,
      });

      const clonedFields = cloneFieldsForRevision({
        currentFields: baseVersion.fields,
        entityVersionId: nextVersionId,
        propertyId: editSession.propertyId,
        replacementContent: {
          encrypted: false,
          fileName: editSession.fileName,
          id: sourceFileId,
          mimeType: DOCX_MIME_TYPE,
          pdfFileId: null,
          pdfDerivative: pdfDerivativeStateForFile({
            encrypted: false,
            mimeType: DOCX_MIME_TYPE,
          }),
          sha256Hex: editSession.docxCheckpointSha256Hex,
          sizeBytes: editSession.docxCheckpointSizeBytes,
          type: "file",
          version: 1,
          ...(editSession.docxCheckpointScanWarnings !== null && {
            scanWarnings: editSession.docxCheckpointScanWarnings,
          }),
        },
        workspaceId: authorizedSession.value.workspaceId,
      });

      const insertedFields = await tx
        .insert(fields)
        .values(clonedFields)
        .returning({ id: fields.id, propertyId: fields.propertyId });

      const nextField = insertedFields.find(
        (field) => field.propertyId === editSession.propertyId,
      );

      await tx
        .update(entities)
        .set({
          currentVersionId: nextVersionId,
          lastEditedBy: authorizedSession.value.userId,
          updatedAt: new Date(),
        })
        .where(eq(entities.id, editSession.entityId));

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, authorizedSession.value.workspaceId));

      await tx
        .update(folioCollabSessions)
        .set({
          closedAt: new Date(),
          finalizedVersionId: nextVersionId,
          status: "finalized",
        })
        .where(eq(folioCollabSessions.id, editSession.id));

      checkpointKeyToDelete = checkpointKey;

      return {
        entityId: editSession.entityId,
        fieldId:
          nextField?.id ??
          panic("Finalized collaborative edit session field was not inserted"),
        outcome: "finalized",
        versionId: nextVersionId,
        versionNumber: nextVersionNumber,
      } as const;
    });

    if ("error" in result) {
      await Promise.all(uploadedKeys.map(deleteUploadedKey));

      if (checkpointKeyToDelete !== null) {
        await deleteCheckpointKey(checkpointKeyToDelete);
      }

      return status(result.error.statusCode, { message: result.error.message });
    }

    shouldRollbackUploadedKeys = false;

    if (checkpointKeyToDelete !== null) {
      await deleteCheckpointKey(checkpointKeyToDelete);
    }

    broadcast(authorizedSession.value.workspaceId, {
      type: "invalidate-query",
      data: ["entities", authorizedSession.value.workspaceId],
    });

    if (result.outcome === "finalized") {
      await processCollaborativeEditDerivatives({
        entityId: result.entityId,
        fieldId: result.fieldId,
        organizationId: authorizedSession.value.organizationId,
        userId: authorizedSession.value.userId,
        versionId: result.versionId,
        workspaceId: authorizedSession.value.workspaceId,
        scopedDb: authorizedSession.value.scopedDb,
      });
    }

    return result;
  } catch (error) {
    if (shouldRollbackUploadedKeys) {
      await Promise.all(uploadedKeys.map(deleteUploadedKey));
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

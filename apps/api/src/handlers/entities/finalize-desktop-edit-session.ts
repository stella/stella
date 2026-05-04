import { panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import {
  desktopEditSessions,
  entities,
  entityVersions,
  fields,
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
import {
  authorizeDesktopEditSession,
  DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE,
  DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE,
  hashDesktopEditSessionToken,
} from "@/api/lib/desktop-edit-sessions";
import { enqueuePdfDerivativeOrMarkFailed } from "@/api/lib/file-derivative-queue";
import { getS3 } from "@/api/lib/s3";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { broadcast } from "@/api/lib/sse";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export const finalizeDesktopEditSessionParamsSchema = t.Object({
  sessionId: tSafeId("desktopEditSession"),
});

export const finalizeDesktopEditSessionBodySchema = t.Object({
  sessionToken: t.String({ minLength: 64, maxLength: 64 }),
});

type FinalizeDesktopEditSessionHandlerProps = {
  body: Static<typeof finalizeDesktopEditSessionBodySchema>;
  sessionId: SafeId<"desktopEditSession">;
};

export const finalizeDesktopEditSessionHandler = async ({
  body: { sessionToken },
  sessionId,
}: FinalizeDesktopEditSessionHandlerProps) => {
  const authorizedSession = await authorizeDesktopEditSession({
    sessionId,
    sessionToken,
  });

  if (authorizedSession.status === "missing") {
    return status(404, {
      message: "Desktop edit session not found.",
    });
  }

  if (authorizedSession.status === "token-mismatch") {
    return status(409, {
      code: DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE,
      message: DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE,
    });
  }

  if (authorizedSession.status === "token-expired") {
    return status(401, {
      code: "desktop_edit_session_token_expired",
      message:
        "Desktop edit session token has expired. Reopen the document from stella.",
    });
  }

  if (authorizedSession.status === "permission-revoked") {
    return status(403, {
      code: "desktop_edit_session_permission_revoked",
      message:
        "Desktop edit permission was revoked. Reopen the document from stella.",
    });
  }

  const uploadedKeys: string[] = [];
  let checkpointKeyToDelete: string | null = null;
  let shouldRollbackUploadedKeys = true;

  const deleteCheckpointKey = async (checkpointKey: string) => {
    await getS3()
      .delete(checkpointKey)
      .catch((error: unknown) => {
        captureError(error, {
          checkpointKey,
          sessionId,
        });
      });
  };

  const deleteUploadedKey = async (uploadedKey: string) => {
    await getS3()
      .delete(uploadedKey)
      .catch((error: unknown) => {
        captureError(error, {
          rollbackKey: uploadedKey,
          sessionId,
        });
      });
  };

  try {
    const result = await authorizedSession.value.scopedDb(async (tx) => {
      const lockedSessions = await tx
        .select({
          baseVersionId: desktopEditSessions.baseVersionId,
          checkpointFileId: desktopEditSessions.checkpointFileId,
          checkpointScanWarnings: desktopEditSessions.checkpointScanWarnings,
          checkpointSha256Hex: desktopEditSessions.checkpointSha256Hex,
          checkpointSizeBytes: desktopEditSessions.checkpointSizeBytes,
          checkpointUpdatedAt: desktopEditSessions.checkpointUpdatedAt,
          entityId: desktopEditSessions.entityId,
          fileName: desktopEditSessions.fileName,
          id: desktopEditSessions.id,
          propertyId: desktopEditSessions.propertyId,
          sessionTokenHash: desktopEditSessions.sessionTokenHash,
          status: desktopEditSessions.status,
        })
        .from(desktopEditSessions)
        .where(
          and(
            eq(desktopEditSessions.id, sessionId),
            eq(
              desktopEditSessions.workspaceId,
              authorizedSession.value.workspaceId,
            ),
          ),
        )
        .for("update");

      const editSession = lockedSessions.at(0);

      if (!editSession) {
        return {
          error: {
            message: "Desktop edit session not found.",
            statusCode: 404,
          },
        } as const;
      }

      if (
        editSession.sessionTokenHash !==
        hashDesktopEditSessionToken(sessionToken)
      ) {
        return {
          error: {
            code: DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE,
            message: DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE,
            statusCode: 409,
          },
        } as const;
      }

      if (editSession.status !== "open") {
        return {
          error: {
            message: "Desktop edit session is already closed.",
            statusCode: 409,
          },
        } as const;
      }

      if (
        editSession.checkpointSha256Hex === null ||
        editSession.checkpointSizeBytes === null ||
        editSession.checkpointUpdatedAt === null
      ) {
        await tx
          .update(desktopEditSessions)
          .set({
            closedAt: new Date(),
            status: "cancelled",
          })
          .where(eq(desktopEditSessions.id, editSession.id));

        return {
          outcome: "no_changes",
        } as const;
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
          error: {
            message: "Entity not found.",
            statusCode: 404,
          },
        } as const;
      }

      const checkpointKey = createFileKey({
        fileId: editSession.checkpointFileId,
        mimeType: DOCX_MIME_TYPE,
        organizationId: authorizedSession.value.organizationId,
        workspaceId: authorizedSession.value.workspaceId,
      });

      if (entity.currentVersionId !== editSession.baseVersionId) {
        await tx
          .update(desktopEditSessions)
          .set({
            closedAt: new Date(),
            status: "cancelled",
          })
          .where(eq(desktopEditSessions.id, editSession.id));

        checkpointKeyToDelete = checkpointKey;

        return {
          error: {
            message:
              "This document changed in Stella while you were editing. Your local copy is preserved.",
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
        columns: {
          versionNumber: true,
        },
        with: {
          fields: {
            columns: {
              content: true,
              propertyId: true,
            },
          },
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
            message: "Desktop edit session source file is no longer available.",
            statusCode: 409,
          },
        } as const;
      }

      if (editSession.checkpointSha256Hex === baseFileField.sha256Hex) {
        await tx
          .update(desktopEditSessions)
          .set({
            closedAt: new Date(),
            status: "cancelled",
          })
          .where(eq(desktopEditSessions.id, editSession.id));

        checkpointKeyToDelete = checkpointKey;

        return {
          outcome: "no_changes",
        } as const;
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
        where: {
          id: { eq: authorizedSession.value.workspaceId },
        },
        columns: {
          reference: true,
        },
      });

      const nextVersionStamp = buildVersionStamp({
        docSequence: entity.docSequence,
        versionNumber: nextVersionNumber,
        workspaceReference:
          workspace?.reference ??
          panic("Workspace not found for finalized desktop edit session"),
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

      // DOCX is rendered natively by Folio; do not create a PDF twin.
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
          sha256Hex: editSession.checkpointSha256Hex,
          sizeBytes: editSession.checkpointSizeBytes,
          type: "file",
          version: 1,
          ...(editSession.checkpointScanWarnings !== null && {
            scanWarnings: editSession.checkpointScanWarnings,
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
          lastEditedBy: authorizedSession.value.userId,
          currentVersionId: nextVersionId,
          updatedAt: new Date(),
        })
        .where(eq(entities.id, editSession.entityId));

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, authorizedSession.value.workspaceId));

      await tx
        .update(desktopEditSessions)
        .set({
          closedAt: new Date(),
          finalizedVersionId: nextVersionId,
          status: "finalized",
        })
        .where(eq(desktopEditSessions.id, editSession.id));

      checkpointKeyToDelete = checkpointKey;

      return {
        entityId: editSession.entityId,
        fieldId:
          nextField?.id ??
          panic("Finalized desktop edit session field was not inserted"),
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

      return status(result.error.statusCode, {
        ...("code" in result.error && { code: result.error.code }),
        message: result.error.message,
      });
    }

    shouldRollbackUploadedKeys = false;

    if (checkpointKeyToDelete !== null) {
      await deleteCheckpointKey(checkpointKeyToDelete);
    }

    if (result.outcome === "finalized") {
      broadcast(authorizedSession.value.workspaceId, {
        type: "invalidate-query",
        data: ["entities", authorizedSession.value.workspaceId],
      });

      await processExtraction(result.entityId).catch((error: unknown) => {
        captureError(error, {
          entityId: result.entityId,
        });
      });

      enqueuePdfDerivativeOrMarkFailed({
        encrypted: false,
        entityId: result.entityId,
        fieldId: result.fieldId,
        mimeType: DOCX_MIME_TYPE,
        organizationId: authorizedSession.value.organizationId,
        userId: brandPersistedUserId(authorizedSession.value.userId),
        workspaceId: authorizedSession.value.workspaceId,
      }).catch((error: unknown) => {
        captureError(error, {
          entityId: result.entityId,
          fieldId: result.fieldId,
          mimeType: DOCX_MIME_TYPE,
        });
      });

      computeVersionDiffStats({
        versionId: result.versionId,
        entityId: result.entityId,
        scopedDb: authorizedSession.value.scopedDb,
        workspaceId: authorizedSession.value.workspaceId,
        organizationId: authorizedSession.value.organizationId,
      }).catch((error: unknown) => {
        captureError(error, { versionId: result.versionId });
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

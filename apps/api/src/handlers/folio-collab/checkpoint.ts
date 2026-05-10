import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { folioCollabSessions } from "@/api/db/schema";
import { createFileKey } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { scanFile } from "@/api/lib/file-scan/scan";
import { authorizeFolioCollabSession } from "@/api/lib/folio-collab-sessions";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { broadcast } from "@/api/lib/sse";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export const checkpointFolioCollabSessionParamsSchema = t.Object({
  sessionId: tSafeId("folioCollabSession"),
});

export const checkpointFolioCollabSessionBodySchema = t.Object({
  file: t.File({
    maxSize: FILE_SIZE_LIMITS.document,
  }),
  token: t.String({ minLength: 64, maxLength: 64 }),
});

type CheckpointFolioCollabSessionHandlerProps = {
  body: Static<typeof checkpointFolioCollabSessionBodySchema>;
  sessionId: SafeId<"folioCollabSession">;
};

export const checkpointFolioCollabSessionHandler = async ({
  body: { file, token },
  sessionId,
}: CheckpointFolioCollabSessionHandlerProps) => {
  if (file.type !== DOCX_MIME_TYPE) {
    return status(400, {
      message: "Collaborative checkpoints currently support only DOCX files.",
    });
  }

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

  const buffer = await file.arrayBuffer();
  const sha256Hex = new Bun.CryptoHasher("sha256").update(buffer).digest("hex");

  const scanResult = await scanFile({
    buffer: new Uint8Array(buffer),
    declaredMimeType: file.type,
    fileName: authorizedSession.value.fileName,
  });

  if (Result.isError(scanResult)) {
    return status(422, { message: "File security scan failed." });
  }

  if (scanResult.value.verdict === "reject") {
    const reasons = scanResult.value.findings
      .filter((finding) => finding.severity === "reject")
      .map((finding) => finding.message);

    return status(422, { message: `File rejected: ${reasons.join("; ")}` });
  }

  const scanWarnings =
    scanResult.value.verdict === "warn"
      ? scanResult.value.findings
          .filter((finding) => finding.severity === "warn")
          .map((finding) => finding.message)
      : null;

  const result = await authorizedSession.value.scopedDb(async (tx) => {
    const existingSessions = await tx
      .select({
        docxCheckpointFileId: folioCollabSessions.docxCheckpointFileId,
        docxCheckpointSha256Hex: folioCollabSessions.docxCheckpointSha256Hex,
        docxCheckpointUpdatedAt: folioCollabSessions.docxCheckpointUpdatedAt,
        id: folioCollabSessions.id,
      })
      .from(folioCollabSessions)
      .where(
        and(
          eq(folioCollabSessions.id, sessionId),
          eq(folioCollabSessions.status, "open"),
          eq(
            folioCollabSessions.workspaceId,
            authorizedSession.value.workspaceId,
          ),
        ),
      )
      .limit(1)
      .for("update");
    const existingSession = existingSessions.at(0);

    if (!existingSession) {
      return status(409, {
        message: "Collaborative edit session is already closed.",
      });
    }

    if (existingSession.docxCheckpointSha256Hex === sha256Hex) {
      return {
        checkpointedAt:
          existingSession.docxCheckpointUpdatedAt?.toISOString() ??
          new Date().toISOString(),
        noop: true,
      };
    }

    const key = createFileKey({
      fileId: existingSession.docxCheckpointFileId,
      mimeType: DOCX_MIME_TYPE,
      organizationId: authorizedSession.value.organizationId,
      workspaceId: authorizedSession.value.workspaceId,
    });

    await getS3().write(key, new Uint8Array(buffer));

    const checkpointedAt = new Date();
    await tx
      .update(folioCollabSessions)
      .set({
        docxCheckpointSha256Hex: sha256Hex,
        docxCheckpointScanWarnings: scanWarnings,
        docxCheckpointSizeBytes: file.size,
        docxCheckpointUpdatedAt: checkpointedAt,
        fileName: authorizedSession.value.fileName,
      })
      .where(eq(folioCollabSessions.id, existingSession.id));

    return {
      checkpointedAt: checkpointedAt.toISOString(),
      noop: false,
    };
  });

  if ("noop" in result && !result.noop) {
    broadcast(authorizedSession.value.workspaceId, {
      type: "invalidate-query",
      data: ["entities", authorizedSession.value.workspaceId],
    });
  }

  return result;
};

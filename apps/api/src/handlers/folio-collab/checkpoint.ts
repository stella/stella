import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { folioCollabSessions } from "@/api/db/schema";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { scanFile } from "@/api/lib/file-scan/scan";
import { authorizeFolioCollabSession } from "@/api/lib/folio-collab-sessions";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { broadcast } from "@/api/lib/sse";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const config = {
  params: t.Object({
    sessionId: tSafeId("folioCollabSession"),
  }),
  body: t.Object({
    file: t.File({
      maxSize: FILE_SIZE_LIMITS.document,
    }),
    token: t.String({ minLength: 64, maxLength: 64 }),
  }),
} satisfies TokenHandlerConfig;

const checkpointFolioCollabSession = createSafeTokenHandler(
  config,
  // eslint-disable-next-line require-yield -- token auth + scopedDb returns plain Promises; nothing to Result.await
  async function* ({ body: { file, token }, params: { sessionId } }) {
    if (file.type !== DOCX_MIME_TYPE) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "Collaborative checkpoints currently support only DOCX files.",
        }),
      );
    }

    const authorizedSession = await authorizeFolioCollabSession({
      sessionId,
      token,
    });

    if (authorizedSession.status === "missing") {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Collaborative edit session not found.",
        }),
      );
    }
    if (authorizedSession.status === "token-expired") {
      return Result.err(
        new HandlerError({
          status: 401,
          message: "Collaborative edit token expired.",
        }),
      );
    }
    if (authorizedSession.status === "permission-revoked") {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Collaborative edit permission revoked.",
        }),
      );
    }

    const { canEdit, fileName, organizationId, scopedDb, workspaceId } =
      authorizedSession.value;

    if (!canEdit) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Collaborative edit is read-only.",
        }),
      );
    }

    const buffer = await file.arrayBuffer();
    const sha256Hex = new Bun.CryptoHasher("sha256")
      .update(buffer)
      .digest("hex");

    const scanResult = await scanFile({
      buffer: new Uint8Array(buffer),
      declaredMimeType: file.type,
      fileName,
    });

    if (Result.isError(scanResult)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "File security scan failed.",
        }),
      );
    }

    if (scanResult.value.verdict === "reject") {
      const reasons = scanResult.value.findings
        .filter((finding) => finding.severity === "reject")
        .map((finding) => finding.message);

      return Result.err(
        new HandlerError({
          status: 422,
          message: `File rejected: ${reasons.join("; ")}`,
        }),
      );
    }

    const scanWarnings =
      scanResult.value.verdict === "warn"
        ? scanResult.value.findings
            .filter((finding) => finding.severity === "warn")
            .map((finding) => finding.message)
        : null;

    const result = await scopedDb(async (tx) => {
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
            eq(folioCollabSessions.workspaceId, workspaceId),
          ),
        )
        .limit(1)
        .for("update");
      const existingSession = existingSessions.at(0);

      if (!existingSession) {
        return {
          error: {
            statusCode: 409 as const,
            message: "Collaborative edit session is already closed.",
          },
        } as const;
      }

      if (existingSession.docxCheckpointSha256Hex === sha256Hex) {
        return {
          checkpointedAt:
            existingSession.docxCheckpointUpdatedAt?.toISOString() ??
            new Date().toISOString(),
          noop: true,
        } as const;
      }

      const key = createFileKey({
        fileId: existingSession.docxCheckpointFileId,
        mimeType: DOCX_MIME_TYPE,
        organizationId,
        workspaceId,
      });

      const s3WriteResult = await Result.tryPromise(
        async () => await getS3().write(key, new Uint8Array(buffer)),
      );

      if (Result.isError(s3WriteResult)) {
        captureError(s3WriteResult.error, {
          sessionId,
          workspaceId,
        });

        return {
          error: {
            statusCode: 500 as const,
            message: "Failed to persist collaborative checkpoint.",
          },
        } as const;
      }

      const checkpointedAt = new Date();
      await tx
        .update(folioCollabSessions)
        .set({
          docxCheckpointSha256Hex: sha256Hex,
          docxCheckpointScanWarnings: scanWarnings,
          docxCheckpointSizeBytes: file.size,
          docxCheckpointUpdatedAt: checkpointedAt,
          fileName,
        })
        .where(eq(folioCollabSessions.id, existingSession.id));

      return {
        checkpointedAt: checkpointedAt.toISOString(),
        noop: false,
      } as const;
    });

    if ("error" in result) {
      return Result.err(
        new HandlerError({
          status: result.error.statusCode,
          message: result.error.message,
        }),
      );
    }

    if (!result.noop) {
      broadcast(workspaceId, {
        type: "invalidate-query",
        data: ["entities", workspaceId],
      });
    }

    return Result.ok(result);
  },
);

export default checkpointFolioCollabSession;

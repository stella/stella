import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { folioCollabSessions } from "@/api/db/schema";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics/capture";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { scanFile } from "@/api/lib/file-scan/scan";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import {
  permissiveBodySchema,
  permissiveRouteSchema,
  validatePostAuth,
} from "@/api/lib/permissive-route-schema";
import { getS3 } from "@/api/lib/s3";
import { broadcast } from "@/api/lib/sse";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

import { authorizeFolioCollabCredentials } from "./session-credentials";

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  params: permissiveRouteSchema({ keys: ["sessionId"] }),
  // The multipart file part is undeclared here on purpose: the permissive
  // schema passes it through untouched and the strict schema below checks
  // it after authorization.
  body: permissiveBodySchema({
    keys: ["token"],
    passthroughKeys: ["file"],
  }),
} satisfies TokenHandlerConfig;

/** Validated after authorization; see `permissive-route-schema.ts`. */
const strictBodySchema = t.Object({
  file: t.File({
    maxSize: FILE_SIZE_LIMITS.document,
  }),
});

const checkpointFolioCollabSession = createSafeTokenHandler(
  config,
  async function* ({ body, params, request, server }) {
    const { session: authorizedSession } = yield* Result.await(
      authorizeFolioCollabCredentials({
        sessionId: params.sessionId,
        token: body?.token,
      }),
    );
    const {
      canEdit,
      fileName,
      organizationId,
      scopedDb,
      sessionId,
      userId,
      workspaceId,
    } = authorizedSession;

    if (!canEdit) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Collaborative edit is read-only.",
        }),
      );
    }

    const validatedBody = validatePostAuth(strictBodySchema, body);
    if (!validatedBody.ok) {
      return Result.err(
        new HandlerError({ status: 422, message: validatedBody.message }),
      );
    }
    const { file } = validatedBody.value;

    if (file.type !== DOCX_MIME_TYPE) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "Collaborative checkpoints currently support only DOCX files.",
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
      const reasons: string[] = [];
      for (const finding of scanResult.value.findings) {
        if (finding.severity === "reject") {
          reasons.push(finding.message);
        }
      }

      return Result.err(
        new HandlerError({
          status: 422,
          message: `File rejected: ${reasons.join("; ")}`,
        }),
      );
    }

    let scanWarnings: string[] | null = null;
    if (scanResult.value.verdict === "warn") {
      scanWarnings = [];
      for (const finding of scanResult.value.findings) {
        if (finding.severity === "warn") {
          scanWarnings.push(finding.message);
        }
      }
    }

    const recordAuditEvent = createAuditRecorder({
      organizationId,
      workspaceId,
      userId,
      request,
      server,
    });

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

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_SESSION,
        resourceId: existingSession.id,
        changes: {
          docxCheckpointSha256Hex: {
            old: existingSession.docxCheckpointSha256Hex,
            new: sha256Hex,
          },
        },
        metadata: {
          fileName,
          sizeBytes: file.size,
          sha256Hex,
        },
      });

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

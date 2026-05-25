import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { folioCollabSessions } from "@/api/db/schema";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  authorizeFolioCollabSession,
  FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
} from "@/api/lib/folio-collab-sessions";
import { getS3 } from "@/api/lib/s3";
import { broadcast } from "@/api/lib/sse";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

type StoredSessionFile = {
  fileId: SafeId<"userFile">;
  mimeType: string;
};

const config = {
  params: t.Object({
    sessionId: tSafeId("folioCollabSession"),
  }),
  body: t.Object({
    token: t.String({ minLength: 64, maxLength: 64 }),
  }),
} satisfies TokenHandlerConfig;

const cancelFolioCollabSession = createSafeTokenHandler(
  config,
  // eslint-disable-next-line require-yield -- token auth + scopedDb returns plain Promises; nothing to Result.await
  async function* ({
    body: { token },
    params: { sessionId },
    request,
    server,
  }) {
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

    const { canEdit, organizationId, scopedDb, userId, workspaceId } =
      authorizedSession.value;

    if (!canEdit) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Collaborative edit is read-only.",
        }),
      );
    }

    const recordAuditEvent = createAuditRecorder({
      organizationId,
      workspaceId,
      userId,
      request,
      server,
    });

    const storedFiles: StoredSessionFile[] = [];
    const cancelled = await scopedDb(async (tx) => {
      const sessions = await tx
        .select({
          docxCheckpointFileId: folioCollabSessions.docxCheckpointFileId,
          docxCheckpointUpdatedAt: folioCollabSessions.docxCheckpointUpdatedAt,
          id: folioCollabSessions.id,
          status: folioCollabSessions.status,
          yjsSnapshotFileId: folioCollabSessions.yjsSnapshotFileId,
          yjsSnapshotUpdatedAt: folioCollabSessions.yjsSnapshotUpdatedAt,
        })
        .from(folioCollabSessions)
        .where(
          and(
            eq(folioCollabSessions.id, sessionId),
            eq(folioCollabSessions.workspaceId, workspaceId),
          ),
        )
        .limit(1)
        .for("update");
      const session = sessions.at(0);

      if (!session) {
        return {
          error: {
            message: "Collaborative edit session not found.",
            statusCode: 404,
          },
        } as const;
      }

      if (session.status !== "open") {
        return {
          error: {
            message: "Collaborative edit session is already closed.",
            statusCode: 409,
          },
        } as const;
      }

      if (session.yjsSnapshotUpdatedAt !== null) {
        storedFiles.push({
          fileId: session.yjsSnapshotFileId,
          mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
        });
      }

      if (session.docxCheckpointUpdatedAt !== null) {
        storedFiles.push({
          fileId: session.docxCheckpointFileId,
          mimeType: DOCX_MIME_TYPE,
        });
      }

      const closedAt = new Date();
      await tx
        .update(folioCollabSessions)
        .set({ closedAt, status: "cancelled" })
        .where(eq(folioCollabSessions.id, session.id));

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_SESSION,
        resourceId: session.id,
        changes: {
          status: { old: session.status, new: "cancelled" },
        },
      });

      return { cancelledAt: closedAt } as const;
    });

    if ("error" in cancelled) {
      return Result.err(
        new HandlerError({
          status: cancelled.error.statusCode,
          message: cancelled.error.message,
        }),
      );
    }

    await Promise.all(
      storedFiles.map(async ({ fileId, mimeType }) => {
        const key = createFileKey({
          fileId,
          mimeType,
          organizationId,
          workspaceId,
        });

        await getS3()
          .delete(key)
          .catch((error: unknown) => {
            captureError(error, { sessionId, storageKey: key });
          });
      }),
    );

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["entities", workspaceId],
    });

    return Result.ok({
      cancelledAt: cancelled.cancelledAt.toISOString(),
    });
  },
);

export default cancelFolioCollabSession;

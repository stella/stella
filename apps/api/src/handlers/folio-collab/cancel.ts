import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { folioCollabSessions } from "@/api/db/schema";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  authorizeFolioCollabSession,
  collectFolioCollabStoredSessionFiles,
  deleteFolioCollabStoredSessionFiles,
} from "@/api/lib/folio-collab-sessions";
import type { FolioCollabStoredSessionFile } from "@/api/lib/folio-collab-sessions";
import {
  permissiveBodySchema,
  permissiveRouteSchema,
  validatePostAuth,
} from "@/api/lib/permissive-route-schema";
import { broadcast } from "@/api/lib/sse";

import {
  folioCollabSessionCredentialsSchema,
  folioCollabSessionNotFoundError,
} from "./session-credentials";

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  params: permissiveRouteSchema({ keys: ["sessionId"] }),
  body: permissiveBodySchema({ keys: ["token"] }),
} satisfies TokenHandlerConfig;

const cancelFolioCollabSession = createSafeTokenHandler(
  config,
  // eslint-disable-next-line require-yield -- token auth + scopedDb returns plain Promises; nothing to Result.await
  async function* ({ body, params, request, server }) {
    const credentials = validatePostAuth(folioCollabSessionCredentialsSchema, {
      sessionId: params.sessionId,
      token: body?.token,
    });
    if (!credentials.ok) {
      return Result.err(folioCollabSessionNotFoundError());
    }
    const { sessionId, token } = credentials.value;

    const authorizedSession = await authorizeFolioCollabSession({
      sessionId,
      token,
    });

    if (authorizedSession.status === "missing") {
      return Result.err(folioCollabSessionNotFoundError());
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

    const storedFiles: FolioCollabStoredSessionFile[] = [];
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

      storedFiles.push(...collectFolioCollabStoredSessionFiles(session));

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

    await deleteFolioCollabStoredSessionFiles({
      files: storedFiles,
      organizationId,
      sessionId,
      workspaceId,
    });

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

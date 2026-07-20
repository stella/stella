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
  collectFolioCollabStoredSessionFiles,
  deleteFolioCollabStoredSessionFiles,
} from "@/api/lib/folio-collab-sessions";
import type { FolioCollabStoredSessionFile } from "@/api/lib/folio-collab-sessions";
import {
  permissiveBodySchema,
  permissiveRouteSchema,
} from "@/api/lib/permissive-route-schema";
import { broadcast } from "@/api/lib/sse";

import { authorizeFolioCollabCredentials } from "./session-credentials";

const config = {
  mcp: { type: "internal", reason: "session_token_exchange" },
  params: permissiveRouteSchema({ keys: ["sessionId"] }),
  body: permissiveBodySchema({ keys: ["token"] }),
} satisfies TokenHandlerConfig;

const cancelFolioCollabSession = createSafeTokenHandler(
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

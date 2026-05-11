import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { folioCollabSessions } from "@/api/db/schema";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  authorizeFolioCollabSession,
  FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
} from "@/api/lib/folio-collab-sessions";
import { getS3 } from "@/api/lib/s3";
import { broadcast } from "@/api/lib/sse";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export const cancelFolioCollabSessionParamsSchema = t.Object({
  sessionId: tSafeId("folioCollabSession"),
});

export const cancelFolioCollabSessionBodySchema = t.Object({
  token: t.String({ minLength: 64, maxLength: 64 }),
});

type CancelFolioCollabSessionHandlerProps = {
  body: Static<typeof cancelFolioCollabSessionBodySchema>;
  sessionId: SafeId<"folioCollabSession">;
};

type StoredSessionFile = {
  fileId: SafeId<"userFile">;
  mimeType: string;
};

export const cancelFolioCollabSessionHandler = async ({
  body: { token },
  sessionId,
}: CancelFolioCollabSessionHandlerProps) => {
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

  const storedFiles: StoredSessionFile[] = [];
  const cancelled = await authorizedSession.value.scopedDb(async (tx) => {
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
          eq(
            folioCollabSessions.workspaceId,
            authorizedSession.value.workspaceId,
          ),
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

    return { cancelledAt: closedAt } as const;
  });

  if ("error" in cancelled) {
    return status(cancelled.error.statusCode, {
      message: cancelled.error.message,
    });
  }

  await Promise.all(
    storedFiles.map(async ({ fileId, mimeType }) => {
      const key = createFileKey({
        fileId,
        mimeType,
        organizationId: authorizedSession.value.organizationId,
        workspaceId: authorizedSession.value.workspaceId,
      });

      await getS3()
        .delete(key)
        .catch((error: unknown) => {
          captureError(error, { sessionId, storageKey: key });
        });
    }),
  );

  broadcast(authorizedSession.value.workspaceId, {
    type: "invalidate-query",
    data: ["entities", authorizedSession.value.workspaceId],
  });

  return { cancelledAt: cancelled.cancelledAt.toISOString() };
};

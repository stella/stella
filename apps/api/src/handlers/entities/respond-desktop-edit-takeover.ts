import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { desktopEditSessions } from "@/api/db/schema";
import {
  authorizeDesktopEditSession,
  computeTokenExpiresAt,
  createDesktopEditSessionToken,
  DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE,
  DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE,
  hashDesktopEditSessionToken,
} from "@/api/lib/desktop-edit-sessions";
import { broadcast } from "@/api/lib/sse";

import {
  closeSessionConnections,
  pushSessionEvent,
} from "./desktop-edit-session-events";

export const respondDesktopEditTakeoverParamsSchema = t.Object({
  sessionId: t.String({ format: "uuid" }),
});

export const respondDesktopEditTakeoverBodySchema = t.Object({
  sessionToken: t.String({ minLength: 64, maxLength: 64 }),
  approved: t.Boolean(),
});

type RespondDesktopEditTakeoverHandlerProps = {
  body: { sessionToken: string; approved: boolean };
  sessionId: string;
};

export const respondDesktopEditTakeoverHandler = async ({
  body: { sessionToken, approved },
  sessionId,
}: RespondDesktopEditTakeoverHandlerProps) => {
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
      message: "Desktop edit session token has expired.",
    });
  }

  const txResult = await authorizedSession.value.scopedDb(async (tx) => {
    const sessions = await tx
      .select({
        id: desktopEditSessions.id,
        takeoverRequestedBy: desktopEditSessions.takeoverRequestedBy,
        workspaceId: desktopEditSessions.workspaceId,
      })
      .from(desktopEditSessions)
      .where(
        and(
          eq(desktopEditSessions.id, sessionId),
          eq(desktopEditSessions.status, "open"),
        ),
      )
      .limit(1)
      .for("update");

    const session = sessions.at(0);
    if (!session || !session.takeoverRequestedBy) {
      return { outcome: "not_found" as const };
    }

    if (approved) {
      const newToken = createDesktopEditSessionToken();
      const newTokenHash = hashDesktopEditSessionToken(newToken);

      await tx
        .update(desktopEditSessions)
        .set({
          createdBy: session.takeoverRequestedBy,
          sessionTokenHash: newTokenHash,
          tokenExpiresAt: computeTokenExpiresAt(),
          takeoverRequestedBy: null,
          takeoverRequestedAt: null,
        })
        .where(eq(desktopEditSessions.id, session.id));

      return {
        outcome: "transferred" as const,
        sessionId: session.id,
        workspaceId: session.workspaceId,
      };
    }

    await tx
      .update(desktopEditSessions)
      .set({
        takeoverRequestedBy: null,
        takeoverRequestedAt: null,
      })
      .where(eq(desktopEditSessions.id, session.id));

    return {
      outcome: "denied" as const,
      workspaceId: session.workspaceId,
    };
  });

  if (txResult.outcome === "not_found") {
    return status(404, { message: "No pending takeover request." });
  }

  // Side effects after transaction commits
  if (txResult.outcome === "transferred") {
    pushSessionEvent(txResult.sessionId, {
      type: "session-taken-over",
      data: { message: DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE },
    });
    closeSessionConnections(txResult.sessionId);
  }

  broadcast(txResult.workspaceId, {
    type: "invalidate-query",
    data: ["entities", txResult.workspaceId],
  });

  return { status: txResult.outcome };
};

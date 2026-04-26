import { status, t } from "elysia";

import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  authorizeDesktopEditSession,
  DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE,
  DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE,
} from "@/api/lib/desktop-edit-sessions";

export const statusDesktopEditSessionParamsSchema = t.Object({
  sessionId: tSafeId("desktopEditSession"),
});

export const statusDesktopEditSessionQuerySchema = t.Object({
  sessionToken: t.String({ minLength: 64, maxLength: 64 }),
});

type StatusDesktopEditSessionHandlerProps = {
  query: { sessionToken: string };
  sessionId: SafeId<"desktopEditSession">;
};

export const statusDesktopEditSessionHandler = async ({
  query: { sessionToken },
  sessionId,
}: StatusDesktopEditSessionHandlerProps) => {
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

  return { status: "open" };
};

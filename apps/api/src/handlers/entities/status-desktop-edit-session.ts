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

const SESSION_TOKEN_LENGTH = 64;
const BEARER_PREFIX = "Bearer ";

export const statusDesktopEditSessionHeadersSchema = t.Object({
  authorization: t.String({
    pattern: `^Bearer [a-f0-9]{${SESSION_TOKEN_LENGTH}}$`,
  }),
});

type StatusDesktopEditSessionHandlerProps = {
  headers: { authorization: string };
  sessionId: SafeId<"desktopEditSession">;
};

export const statusDesktopEditSessionHandler = async ({
  headers: { authorization },
  sessionId,
}: StatusDesktopEditSessionHandlerProps) => {
  // The schema's regex enforces this shape, but we re-check at runtime
  // so a future schema change can't silently widen what reaches the
  // authorization step.
  if (
    !authorization.startsWith(BEARER_PREFIX) ||
    authorization.length !== BEARER_PREFIX.length + SESSION_TOKEN_LENGTH
  ) {
    return status(401, {
      code: "desktop_edit_session_token_missing",
      message: "Desktop edit session token missing or malformed.",
    });
  }
  const sessionToken = authorization.slice(BEARER_PREFIX.length);

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

  return { status: "open" };
};

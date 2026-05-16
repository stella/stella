import { beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

const authorizeDesktopEditSessionMock = mock();
const readDesktopEditSessionEventStateMock = mock();

void mock.module("@/api/lib/desktop-edit-sessions", () => ({
  authorizeDesktopEditSession: authorizeDesktopEditSessionMock,
  DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE: "desktop_edit_session_taken_over",
  DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE:
    "Desktop editing moved to another device. This local copy is preserved.",
  readDesktopEditSessionEventState: readDesktopEditSessionEventStateMock,
}));

const { desktopEditSessionEventsHandler } =
  await import("@/api/handlers/entities/desktop-edit-session-events");

const sessionId = toSafeId<"desktopEditSession">(
  "019aa0bc-d957-7bb3-9234-9c2440377225",
);

describe("desktop edit session events", () => {
  beforeEach(() => {
    authorizeDesktopEditSessionMock.mockReset();
    readDesktopEditSessionEventStateMock.mockReset();
  });

  test("rejects missing tokens before reading session state", async () => {
    const response = await desktopEditSessionEventsHandler({
      headers: {},
      query: {},
      sessionId,
    });

    expect(authorizeDesktopEditSessionMock).not.toHaveBeenCalled();
    expect(readDesktopEditSessionEventStateMock).not.toHaveBeenCalled();
    expect(response).toHaveProperty("code", 401);
    expect(response).toHaveProperty(
      "response.code",
      "desktop_edit_session_token_missing",
    );
  });
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { desktopEditSessionEventsHandler } from "@/api/handlers/entities/desktop-edit-session-events";
import { toSafeId } from "@/api/lib/branded-types";

const authorizeDesktopEditSessionMock = mock();
const readDesktopEditSessionEventStateMock = mock();
const refreshDesktopEditSessionLivenessMock = mock();

const desktopEditSessionEventsHandlerForTest = async (
  input: Parameters<typeof desktopEditSessionEventsHandler>[0],
) =>
  await desktopEditSessionEventsHandler(input, {
    authorizeDesktopEditSession: authorizeDesktopEditSessionMock,
    livenessRefreshIntervalMs: 60_000,
    readDesktopEditSessionEventState: readDesktopEditSessionEventStateMock,
    refreshDesktopEditSessionLiveness: refreshDesktopEditSessionLivenessMock,
  });

const sessionId = toSafeId<"desktopEditSession">(
  "019aa0bc-d957-7bb3-9234-9c2440377225",
);
const sessionToken = "a".repeat(64);

describe("desktop edit session events", () => {
  beforeEach(() => {
    authorizeDesktopEditSessionMock.mockReset();
    readDesktopEditSessionEventStateMock.mockReset();
    refreshDesktopEditSessionLivenessMock.mockReset();
    refreshDesktopEditSessionLivenessMock.mockResolvedValue(true);
  });

  test("rejects missing tokens before reading session state", async () => {
    const response = await desktopEditSessionEventsHandlerForTest({
      headers: {},
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

  test("refreshes liveness when an event stream connects", async () => {
    authorizeDesktopEditSessionMock.mockResolvedValue({
      status: "authorized",
      value: { userId: "user-1" },
    });
    readDesktopEditSessionEventStateMock.mockResolvedValue({
      pendingRequest: null,
    });

    const response = await desktopEditSessionEventsHandlerForTest({
      headers: { authorization: `Bearer ${sessionToken}` },
      sessionId,
    });

    if (!(response instanceof Response)) {
      throw new Error(
        "Expected desktop edit events to return an SSE response.",
      );
    }

    expect(refreshDesktopEditSessionLivenessMock).toHaveBeenCalledWith({
      sessionId,
      sessionToken,
      userId: "user-1",
    });

    await response.body?.cancel();
  });

  test("awaits the first liveness refresh before returning the stream", async () => {
    authorizeDesktopEditSessionMock.mockResolvedValue({
      status: "authorized",
      value: { userId: "user-1" },
    });
    readDesktopEditSessionEventStateMock.mockResolvedValue({
      pendingRequest: null,
    });

    let resolveRefresh: (value: boolean) => void = () => {
      throw new Error("Expected liveness refresh to start.");
    };
    const refreshPromise = new Promise<boolean>((resolve) => {
      resolveRefresh = resolve;
    });
    refreshDesktopEditSessionLivenessMock.mockReturnValue(refreshPromise);

    let settled = false;
    const responsePromise = desktopEditSessionEventsHandlerForTest({
      headers: { authorization: `Bearer ${sessionToken}` },
      sessionId,
    }).then((response) => {
      settled = true;
      return response;
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(refreshDesktopEditSessionLivenessMock).toHaveBeenCalledWith({
      sessionId,
      sessionToken,
      userId: "user-1",
    });
    expect(settled).toBe(false);
    resolveRefresh(true);

    const response = await responsePromise;
    if (!(response instanceof Response)) {
      throw new Error(
        "Expected desktop edit events to return an SSE response.",
      );
    }

    await response.body?.cancel();
  });
});

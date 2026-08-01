import type { SafeId } from "@/api/lib/branded-types";
import { broadcastSessionEvent } from "@/api/lib/sse";
import type { SSEEvent } from "@/api/lib/sse-broadcast";

export const DESKTOP_EDIT_SESSION_CLOSE_SIGNAL =
  "__desktop_edit_session_closed__";

export const desktopEditSessionClosedEvent = (reason: string): SSEEvent => ({
  type: "session-closed",
  data: { reason },
});

export const desktopEditSessionCloseSignal = (): SSEEvent => ({
  type: DESKTOP_EDIT_SESSION_CLOSE_SIGNAL,
  data: null,
});

export const isDesktopEditSessionCloseSignal = (event: SSEEvent): boolean =>
  event.type === DESKTOP_EDIT_SESSION_CLOSE_SIGNAL;

/** Broadcast an event to this session's SSE streams on every API instance. */
export const pushSessionEvent = (
  sessionId: SafeId<"desktopEditSession">,
  event: SSEEvent,
): void => {
  broadcastSessionEvent(sessionId, event);
};

/** Close this session's SSE streams on every API instance. */
export const closeSessionConnections = (
  sessionId: SafeId<"desktopEditSession">,
): void => {
  broadcastSessionEvent(sessionId, desktopEditSessionCloseSignal());
};

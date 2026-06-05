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

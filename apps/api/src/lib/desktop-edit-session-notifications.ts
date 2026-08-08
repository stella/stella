import {
  REALTIME_EVENT_TYPE,
  type DesktopEditSessionRealtimeEvent,
} from "@stll/api-contract";

import type { SafeId } from "@/api/lib/branded-types";
import { broadcastSessionEvent } from "@/api/lib/sse";

export const DESKTOP_EDIT_SESSION_CLOSE_SIGNAL =
  REALTIME_EVENT_TYPE.DESKTOP_EDIT_SESSION_CLOSED;

export const desktopEditSessionClosedEvent = (
  reason: string,
): DesktopEditSessionRealtimeEvent => ({
  type: REALTIME_EVENT_TYPE.SESSION_CLOSED,
  data: { reason },
});

type DesktopEditSessionCloseSignal = Extract<
  DesktopEditSessionRealtimeEvent,
  { type: typeof DESKTOP_EDIT_SESSION_CLOSE_SIGNAL }
>;

export const desktopEditSessionCloseSignal =
  (): DesktopEditSessionCloseSignal => ({
    type: DESKTOP_EDIT_SESSION_CLOSE_SIGNAL,
    data: null,
  });

export const isDesktopEditSessionCloseSignal = (
  event: DesktopEditSessionRealtimeEvent,
): event is DesktopEditSessionCloseSignal =>
  event.type === DESKTOP_EDIT_SESSION_CLOSE_SIGNAL;

/** Broadcast an event to this session's SSE streams on every API instance. */
export const pushSessionEvent = (
  sessionId: SafeId<"desktopEditSession">,
  event: DesktopEditSessionRealtimeEvent,
): void => {
  broadcastSessionEvent(sessionId, event);
};

/** Close this session's SSE streams on every API instance. */
export const closeSessionConnections = (
  sessionId: SafeId<"desktopEditSession">,
): void => {
  broadcastSessionEvent(sessionId, desktopEditSessionCloseSignal());
};

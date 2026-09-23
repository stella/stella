// The browser stops reconnecting (readyState CLOSED) on a non-2xx response,
// a wrong content type, or a network change — states a fresh EventSource
// usually recovers from. Re-establish with capped exponential backoff and
// escalate to telemetry once per outage episode, only after several
// consecutive failures while the browser reports itself online: a laptop
// waking from sleep should reconnect quietly, not page.
const SSE_RECONNECT_BASE_DELAY_MS = 1000;
const SSE_RECONNECT_MAX_DELAY_MS = 30_000;
export const SSE_ESCALATE_AFTER_FAILURES = 5;

export const sseReconnectDelayMs = (failures: number): number =>
  Math.min(
    SSE_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, failures - 1),
    SSE_RECONNECT_MAX_DELAY_MS,
  );

/**
 * What a refused reconnect means. An EventSource never exposes the status
 * that closed it, so the loop asks the stream URL directly before retrying.
 */
export const WORKSPACE_STREAM_ACCESS = {
  AVAILABLE: "available",
  ENDED: "ended",
} as const;

export type WorkspaceStreamAccess =
  (typeof WORKSPACE_STREAM_ACCESS)[keyof typeof WORKSPACE_STREAM_ACCESS];

// The stream's access check answers 404 for a matter the caller cannot see,
// whether it never existed, was archived or deleted, or their membership
// ended. Every other answer, including a failed request, is an outage the
// loop keeps retrying through.
const MATTER_NOT_FOUND_STATUS = 404;

export const workspaceStreamAccessFromStatus = (
  status: number | null,
): WorkspaceStreamAccess =>
  status === MATTER_NOT_FOUND_STATUS
    ? WORKSPACE_STREAM_ACCESS.ENDED
    : WORKSPACE_STREAM_ACCESS.AVAILABLE;

/** The callbacks one EventSource reports through. */
export type WorkspaceStreamHandlers = {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onError: () => void;
};

/** The part of an EventSource the connection loop drives. */
export type WorkspaceStreamSource = {
  /** Whether the browser has given up on this source (readyState CLOSED). */
  isClosed: () => boolean;
  close: () => void;
};

export type ConnectWorkspaceStreamOptions = {
  openSource: (handlers: WorkspaceStreamHandlers) => WorkspaceStreamSource;
  isOnline: () => boolean;
  /** Run `callback` after `delayMs`; returns a function that cancels it. */
  schedule: (callback: () => void, delayMs: number) => () => void;
  /**
   * Ask the stream URL whether this matter is still open to the caller and
   * report the answer through `settle`.
   */
  probeAccess: (settle: (access: WorkspaceStreamAccess) => void) => void;
  onMessage: (data: string) => void;
  onOutage: () => void;
  /** The caller's access to the matter ended; the loop has stopped. */
  onAccessEnded: () => void;
};

/**
 * Keep one workspace event stream connected until the returned dispose runs.
 *
 * The native EventSource retry covers transient drops; once the browser gives
 * up (readyState CLOSED) the loop checks whether the matter itself refused
 * the connection. A refusal ends the loop through `onAccessEnded`; anything
 * else opens a new source with capped backoff.
 */
export const connectWorkspaceStream = ({
  openSource,
  isOnline,
  schedule,
  probeAccess,
  onMessage,
  onOutage,
  onAccessEnded,
}: ConnectWorkspaceStreamOptions): (() => void) => {
  let source: WorkspaceStreamSource | null = null;
  let cancelReconnect: (() => void) | null = null;
  let consecutiveFailures = 0;
  // Offline failures back off but never count toward the outage capture:
  // they would either trip it on the first failure after coming back
  // online, or overshoot the threshold so a real outage never equals it.
  let consecutiveOnlineFailures = 0;
  let disposed = false;

  const scheduleReconnect = () => {
    consecutiveFailures += 1;
    if (isOnline()) {
      consecutiveOnlineFailures += 1;
      if (consecutiveOnlineFailures === SSE_ESCALATE_AFTER_FAILURES) {
        onOutage();
      }
    } else {
      consecutiveOnlineFailures = 0;
    }
    cancelReconnect = schedule(() => {
      cancelReconnect = null;
      connect();
    }, sseReconnectDelayMs(consecutiveFailures));
  };

  const settleClosedSource = (access: WorkspaceStreamAccess) => {
    if (disposed) {
      return;
    }
    if (access === WORKSPACE_STREAM_ACCESS.ENDED) {
      disposed = true;
      onAccessEnded();
      return;
    }
    scheduleReconnect();
  };

  const connect = () => {
    const stream = openSource({
      onOpen: () => {
        consecutiveFailures = 0;
        consecutiveOnlineFailures = 0;
      },
      onMessage,
      onError: () => {
        // readyState CONNECTING means the browser is retrying on its own;
        // only a fully closed source needs our reconnect loop.
        if (!stream.isClosed() || disposed) {
          return;
        }
        stream.close();
        probeAccess(settleClosedSource);
      },
    });
    source = stream;
  };

  connect();

  return () => {
    disposed = true;
    cancelReconnect?.();
    source?.close();
  };
};

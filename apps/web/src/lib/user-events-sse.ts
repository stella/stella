import { parseUserRealtimeEvent } from "@stll/api-contract";
import type { UserRealtimeEvent } from "@stll/api-contract";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { apiUrl } from "@/lib/api-url";

const USER_SSE_EVENT_SOURCE_INIT = {
  withCredentials: true,
} satisfies EventSourceInit;

/**
 * The browser gives up reconnecting (readyState CLOSED) on a non-2xx response,
 * a wrong content type, or a network change. Re-establish with capped
 * exponential backoff, mirroring the workspace stream.
 */
const SSE_RECONNECT_BASE_DELAY_MS = 1000;
const SSE_RECONNECT_MAX_DELAY_MS = 30_000;

const reconnectDelayMs = (failures: number): number =>
  Math.min(
    SSE_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, failures - 1),
    SSE_RECONNECT_MAX_DELAY_MS,
  );

/**
 * Subscribe to the signed-in user's own event stream.
 *
 * Separate from the workspace stream on purpose: this one follows the person,
 * not the matter they happen to have open, so the bell keeps working on
 * routes that have no workspace at all. Events are content-free — they say
 * "your notifications changed", and the handler re-reads through the ordinary
 * authorized endpoint.
 *
 * Reconnects are deliberately quiet here: an outage costs a delayed badge, not
 * lost data, and the workspace stream already reports connection failures for
 * the same session.
 */
export const useUserEventsSSE = (
  onEvent: (event: UserRealtimeEvent) => void,
): void => {
  const handleEvent = useLatestCallback(onEvent);

  useExternalSyncEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;
    let disposed = false;

    const connect = () => {
      const stream = new EventSource(
        apiUrl("/notifications/events"),
        USER_SSE_EVENT_SOURCE_INIT,
      );
      source = stream;

      stream.addEventListener("open", () => {
        consecutiveFailures = 0;
      });
      stream.addEventListener("message", (event: MessageEvent) => {
        const parsed = parseUserRealtimeEvent(jsonOrNull(String(event.data)));
        if (parsed) {
          handleEvent(parsed);
        }
      });
      stream.addEventListener("error", () => {
        // CONNECTING means the browser is retrying on its own.
        if (stream.readyState !== EventSource.CLOSED || disposed) {
          return;
        }
        stream.close();
        consecutiveFailures += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, reconnectDelayMs(consecutiveFailures));
      });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      source?.close();
    };
  }, [handleEvent]);
};

const jsonOrNull = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

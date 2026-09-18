/**
 * The keep-alive frame every Stella `text/event-stream` response writes while
 * its producer is silent, and the one place the server's writer and the
 * browser's readers agree on its bytes.
 *
 * A line opened with `:` is a comment in the event-stream grammar: a reader
 * ignores it and dispatches nothing, so the frame keeps the connection busy
 * without adding an event.
 */
export const SSE_HEARTBEAT_FRAME = ":keepalive\n\n";

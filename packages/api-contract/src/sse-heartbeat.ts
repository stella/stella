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

/**
 * The longest a Stella event stream stays silent before it writes the frame.
 * The CDN and the load balancer in front of the service both cut a connection
 * after 60 s without a byte, so the interval leaves room for three writes
 * inside one of their windows.
 */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Silence after which a reader holds an event stream to be lost: three
 * intervals, so two frames in a row may arrive late or not at all before a
 * live stream is given up. A stream is bounded by this, never by how long it
 * has run: a turn that works for hours keeps one stream for as long as the
 * frames arrive.
 */
export const SSE_SILENCE_BOUND_MS = SSE_HEARTBEAT_INTERVAL_MS * 3;

/**
 * Keep-alive idle timeout in seconds: longer than the load balancer's 60 s
 * idle timeout (Bun defaults to 10 s). The balancer may reuse an idle backend
 * connection any time before its own timeout expires, so the server must
 * never close first: a request written onto a connection the server is
 * closing is lost in flight and the client hangs with no response and no
 * server-side log line. The SSE keep-alive heartbeat (20 s) stays well inside
 * this window, and so does a public read's 30 s statement timeout.
 */
/** This transport setting is not an absolute handler deadline. */
export const HTTP_IDLE_TIMEOUT_S = 75;

/** Match the existing public-read statement deadline within the transport window. */
export const HTTP_REQUEST_DATABASE_BUDGET_MS = 30_000;

import publishAnnouncement from "@/api/handlers/notifications/announce";
import listNotifications from "@/api/handlers/notifications/list";
import markAllNotificationsRead from "@/api/handlers/notifications/read-all";
import markNotificationRead from "@/api/handlers/notifications/read-state/update";
import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";
import { sseResponse, subscribeUser } from "@/api/lib/sse";

/**
 * User-scoped SSE stream. Native EventSource cannot send headers, so this
 * uses cookie credentials through the ordinary member access, exactly like the
 * workspace stream, and refuses a `?token=` credential for the same reason:
 * a query-string secret lands in proxy logs, referrers and history.
 *
 * The stream is bound to the session's active organization for its whole
 * life; a client that switches firms opens a new one rather than having
 * this one re-point. The organization is never read off the request: the
 * session is the only source that may name it.
 */
const userEvents = defineEndpoint.member({}, ({ request, session, user }) => {
  if (new URL(request.url).searchParams.has("token")) {
    return new Response("Token query parameter is not supported", {
      status: 400,
    });
  }
  return sseResponse(
    subscribeUser({
      organizationId: session.activeOrganizationId,
      sessionId: session.id,
      signal: request.signal,
      userId: user.id,
    }),
    { kind: "session", sessionId: session.id, userId: user.id },
  );
});

// It shares the standard API limiter scope, so callers cannot bypass or double
// the budget by taking this path.
export const notificationsRoute = routes(
  {
    "/events": { GET: userEvents },
    "/": { GET: listNotifications },
    "/read-all": { POST: markAllNotificationsRead },
    "/announcements": { POST: publishAnnouncement },
    "/:notificationId/read": { PATCH: markNotificationRead },
  },
  {
    prefix: "/v1/notifications",
    middleware: [rateLimit(createStandardApiRateLimitOptions())],
  },
);

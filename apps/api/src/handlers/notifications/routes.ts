import Elysia from "elysia";

import publishAnnouncement from "@/api/handlers/notifications/announce";
import listNotifications from "@/api/handlers/notifications/list";
import markNotificationRead from "@/api/handlers/notifications/read";
import markAllNotificationsRead from "@/api/handlers/notifications/read-all";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";
import { subscribeUser } from "@/api/lib/sse";

// Mounted at `/v1/notifications` directly at the root, like `/v1/memories`:
// folding another `.use()` into the large `/v1` group tips Elysia's inferred
// type past TypeScript's complexity threshold and collapses Eden's client
// types across the whole web app. It shares the standard API limiter scope, so
// callers cannot bypass or double the budget by taking this path.
export const notificationsRoute = new Elysia({
  prefix: "/v1/notifications",
})
  .use(rateLimit(createStandardApiRateLimitOptions()))
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  /**
   * User-scoped SSE stream. Native EventSource cannot send headers, so this
   * uses cookie credentials through the ordinary auth macro, exactly like the
   * workspace stream — and refuses a `?token=` credential for the same reason:
   * a query-string secret lands in proxy logs, referrers and history.
   */
  .get(
    "/events",
    ({
      request,
      session,
      user,
    }: {
      request: Request;
      session: { activeOrganizationId: SafeId<"organization"> };
      user: { id: SafeId<"user"> };
    }) => {
      if (new URL(request.url).searchParams.has("token")) {
        return new Response("Token query parameter is not supported", {
          status: 400,
        });
      }

      const stream = subscribeUser({
        organizationId: session.activeOrganizationId,
        signal: request.signal,
        userId: user.id,
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-store",
          Connection: "keep-alive",
        },
      });
    },
  )
  .get("/", listNotifications.handler, {
    query: listNotifications.config.query,
    permissions: listNotifications.config.permissions,
  })
  .post("/read-all", markAllNotificationsRead.handler, {
    permissions: markAllNotificationsRead.config.permissions,
  })
  .post("/announcements", publishAnnouncement.handler, {
    body: publishAnnouncement.config.body,
    permissions: publishAnnouncement.config.permissions,
  })
  .patch("/:notificationId/read", markNotificationRead.handler, {
    params: markNotificationRead.config.params,
    permissions: markNotificationRead.config.permissions,
  });

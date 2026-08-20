import Elysia from "elysia";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { subscribe } from "@/api/lib/sse";
import listNotifications from "./list";
import markNotificationRead from "./read";
import markAllNotificationsRead from "./read-all";
import publishProductNews from "./product-news";

export const notificationsRoute = new Elysia({ prefix: "/notifications" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/events", ({ request, user }) => {
    const stream = subscribe({
      organizationId: null as any,
      signal: request.signal,
      userId: user.id,
      workspaceId: `user-events:${user.id}` as any,
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
      },
    });
  })
  .get("/", listNotifications.handler, {
    query: listNotifications.config.query,
    permissions: listNotifications.config.permissions,
  })
  .patch("/:notificationId/read", markNotificationRead.handler, {
    params: markNotificationRead.config.params,
    permissions: markNotificationRead.config.permissions,
  })
  .post("/read-all", markAllNotificationsRead.handler, {
    permissions: markAllNotificationsRead.config.permissions,
  })
  .post("/product-news", publishProductNews.handler, {
    body: publishProductNews.config.body,
    permissions: publishProductNews.config.permissions,
  });

export default notificationsRoute;

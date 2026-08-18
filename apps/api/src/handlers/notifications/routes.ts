import Elysia from "elysia";
import { authMacro } from "@/api/lib/auth";
import listNotifications from "./list";
import markNotificationRead from "./read";
import markAllNotificationsRead from "./read-all";
import publishProductNews from "./product-news";

export const notificationsRoute = new Elysia({ prefix: "/notifications" })
  .use(authMacro)
  .guard({ validateAuth: true })
  .get("/", listNotifications.handler, {
    query: listNotifications.config.query,
  })
  .patch("/:notificationId/read", markNotificationRead.handler, {
    params: markNotificationRead.config.params,
  })
  .post("/read-all", markAllNotificationsRead.handler)
  .post("/product-news", publishProductNews.handler, {
    body: publishProductNews.config.body,
  });

export default notificationsRoute;

import publishAnnouncement from "@/api/handlers/notifications/announce";
import userEvents from "@/api/handlers/notifications/events";
import listNotifications from "@/api/handlers/notifications/list";
import markAllNotificationsRead from "@/api/handlers/notifications/read-all";
import markNotificationRead from "@/api/handlers/notifications/read-state/update";
import { routes } from "@/api/http/route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

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

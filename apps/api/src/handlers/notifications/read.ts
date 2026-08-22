import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { notifications } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { brandPersistedNotificationId } from "@/api/lib/safe-id-boundaries";

const config = {
  permissions: { workspace: ["read"] },
  access: "write",
  mcp: { type: "internal", reason: "native_tool_ui" },
  params: t.Object({
    notificationId: t.String(),
  }),
} satisfies HandlerConfig;

const markNotificationRead = createSafeRootHandler(
  config,
  async function* ({ safeDb, user, params }) {
    const rawNotificationId = params["notificationId"];
    const notificationId = brandPersistedNotificationId(rawNotificationId);
    yield* Result.await(
      safeDb((tx) =>
        tx
          .update(notifications)
          .set({ isRead: true, readAt: new Date() })
          .where(and(eq(notifications.id, notificationId), eq(notifications.userId, user.id))),
      ),
    );
    return Result.ok({ success: true });
  },
);

export default markNotificationRead;

import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { notifications } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["read"] },
  access: "write",
  mcp: { type: "internal", reason: "native_tool_ui" },
} satisfies HandlerConfig;

const markAllNotificationsRead = createSafeRootHandler(
  config,
  async function* ({ safeDb, user }) {
    yield* Result.await(
      safeDb((tx) =>
        tx
          .update(notifications)
          .set({ isRead: true, readAt: new Date() })
          .where(eq(notifications.userId, user.id)),
      ),
    );
    return Result.ok({ success: true });
  },
);

export default markAllNotificationsRead;

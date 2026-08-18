import { Result } from "better-result";
import { t } from "elysia";

import { user } from "@/api/db/auth-schema";
import { notifications } from "@/api/db/schema";
import { rootDb } from "@/api/db/root";
import { createSafeId } from "@/api/lib/branded-types";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { broadcastUserNotification } from "@/api/lib/sse";

const config = {
  // Only org admins may broadcast announcements to all users.
  permissions: { organization: ["update"] },
  access: "write",
  mcp: { type: "internal", reason: "native_tool_ui" },
  body: t.Object({
    title: t.String({ minLength: 1 }),
    message: t.String({ minLength: 1 }),
  }),
} satisfies HandlerConfig;

const publishProductNews = createSafeRootHandler(
  config,
  async function* ({ body }) {
    const allUsers = await rootDb.select({ id: user.id }).from(user);
    if (allUsers.length === 0) {
      return Result.ok({ success: true, count: 0 });
    }

    // Single bulk insert — one round-trip regardless of user count.
    const rows = allUsers.map((u) => ({
      id: createSafeId<"notification">(),
      userId: brandPersistedUserId(u.id),
      title: body["title"],
      message: body["message"],
      entityType: "announcement" as const,
      entityId: null,
    }));

    await rootDb.transaction(async (tx) => {
      await tx.insert(notifications).values(rows);
    });

    // Broadcast live SSE invalidation to each recipient after commit.
    const event = {
      type: "new-notification" as const,
      data: {
        id: rows[0]!.id,
        title: body["title"],
        message: body["message"],
        isRead: false,
        createdAt: new Date().toISOString(),
        entityType: "announcement",
        entityId: null,
      },
    };
    for (const u of allUsers) {
      broadcastUserNotification(brandPersistedUserId(u.id), event);
    }

    return Result.ok({ success: true, count: allUsers.length });
  }
);

export default publishProductNews;

import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { desktopEditSessions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";
import { broadcast } from "@/api/lib/sse";

const config = {
  permissions: { entity: ["update"] },
  body: t.Object({
    entityId: tUuid,
    propertyId: tUuid,
  }),
} satisfies HandlerConfig;

export default createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body }) {
    yield* Result.await(
      safeDb((tx) =>
        tx
          .update(desktopEditSessions)
          .set({ status: "cancelled" })
          .where(
            and(
              eq(desktopEditSessions.entityId, body.entityId),
              eq(desktopEditSessions.propertyId, body.propertyId),
              eq(desktopEditSessions.workspaceId, workspaceId),
              eq(desktopEditSessions.status, "open"),
            ),
          ),
      ),
    );

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["entities", workspaceId],
    });

    return Result.ok({ released: true });
  },
);

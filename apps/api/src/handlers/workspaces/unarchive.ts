import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { workspaces } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["update"] },
} satisfies HandlerConfig;

const unarchiveWorkspace = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId }) {
    yield* Result.await(
      safeDb((tx) =>
        tx
          .update(workspaces)
          .set({ status: "active" })
          .where(
            and(
              eq(workspaces.id, workspaceId),
              eq(workspaces.status, "archived"),
            ),
          ),
      ),
    );

    return Result.ok({ success: true as const });
  },
);

export default unarchiveWorkspace;

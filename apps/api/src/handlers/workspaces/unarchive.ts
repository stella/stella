import { and, eq } from "drizzle-orm";

import { workspaces } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["update"] },
} satisfies HandlerConfig;

const unarchiveWorkspace = createHandler(
  config,
  async ({ scopedDb, workspaceId }) =>
    await scopedDb((tx) =>
      tx
        .update(workspaces)
        .set({ status: "active" })
        .where(
          and(
            eq(workspaces.id, workspaceId),
            eq(workspaces.status, "archived"),
          ),
        ),
    ).then(() => ({ success: true as const })),
);

export default unarchiveWorkspace;

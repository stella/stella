import { eq, sql } from "drizzle-orm";
import { status, t } from "elysia";

import { workspaceViews } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { broadcast } from "@/api/lib/sse";

const config = {
  permissions: { view: ["update"] },
  body: t.Object({
    viewIds: t.Array(tNanoid, { minItems: 1 }),
  }),
} satisfies HandlerConfig;

const reorderViews = createHandler(
  config,
  async ({ scopedDb, workspaceId, body: { viewIds } }) => {
    if (new Set(viewIds).size !== viewIds.length) {
      return status(400, { message: "Duplicate view IDs" });
    }

    // Validate before mutating: check that all supplied IDs
    // match the existing views in this workspace.
    const existing = await scopedDb((tx) =>
      tx
        .select({ id: workspaceViews.id })
        .from(workspaceViews)
        .where(eq(workspaceViews.workspaceId, workspaceId)),
    );

    if (viewIds.length !== existing.length) {
      return status(400, {
        message: "View IDs must include all views in the workspace",
      });
    }

    const existingIds = new Set(existing.map((v) => v.id));
    for (const id of viewIds) {
      if (!existingIds.has(id)) {
        return status(400, {
          message: "View IDs must include all views in the workspace",
        });
      }
    }

    // Build a single CASE expression to update all positions at once.
    const cases = viewIds.map(
      (id, i) => sql`when ${workspaceViews.id} = ${id} then ${i}`,
    );

    await scopedDb((tx) =>
      tx
        .update(workspaceViews)
        .set({
          position: sql`case ${sql.join(cases, sql` `)} end`,
        })
        .where(eq(workspaceViews.workspaceId, workspaceId)),
    );

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["views", workspaceId],
    });

    return undefined;
  },
);

export default reorderViews;

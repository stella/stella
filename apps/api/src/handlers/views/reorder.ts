import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { workspaceViews } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { broadcast } from "@/api/lib/sse";

const config = {
  permissions: { view: ["update"] },
  body: t.Object({
    viewIds: t.Array(tNanoid, { minItems: 1 }),
  }),
} satisfies HandlerConfig;

const reorderViews = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body: { viewIds } }) {
    if (new Set(viewIds).size !== viewIds.length) {
      return Result.err(
        new HandlerError({ status: 400, message: "Duplicate view IDs" }),
      );
    }

    // Validate before mutating: check that all supplied IDs
    // match the existing views in this workspace.
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ id: workspaceViews.id })
          .from(workspaceViews)
          .where(eq(workspaceViews.workspaceId, workspaceId)),
      ),
    );

    if (viewIds.length !== existing.length) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "View IDs must include all views in the workspace",
        }),
      );
    }

    const existingIds = new Set(existing.map((v) => v.id));
    for (const id of viewIds) {
      if (!existingIds.has(id)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "View IDs must include all views in the workspace",
          }),
        );
      }
    }

    // Build a single CASE expression to update all positions at once.
    const cases = viewIds.map(
      (id, i) => sql`when ${workspaceViews.id} = ${id} then ${i}`,
    );

    yield* Result.await(
      safeDb((tx) =>
        tx
          .update(workspaceViews)
          .set({
            position: sql`case ${sql.join(cases, sql` `)} end`,
          })
          .where(eq(workspaceViews.workspaceId, workspaceId)),
      ),
    );

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["views", workspaceId],
    });

    return Result.ok(undefined);
  },
);

export default reorderViews;

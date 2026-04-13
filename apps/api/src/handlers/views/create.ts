import { eq, sql } from "drizzle-orm";
import { status, t } from "elysia";
import * as v from "valibot";

import { workspaceViews } from "@/api/db/schema";
import {
  hasDuplicateSorts,
  hasMultipleKindFilters,
} from "@/api/handlers/views/utils";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { broadcast } from "@/api/lib/sse";
import { viewLayoutSchema } from "@/api/lib/views-schema";

const config = {
  permissions: { view: ["create"] },
  body: t.Object({
    id: tNanoid,
    name: tDefaultVarchar,
    layout: t.Any(),
  }),
} satisfies HandlerConfig;

const createView = createHandler(
  config,
  async ({ scopedDb, workspaceId, body }) => {
    const parsed = v.safeParse(viewLayoutSchema, body.layout);
    if (!parsed.success) {
      return status(400, { message: "Invalid layout" });
    }
    const layout = parsed.output;

    if (hasDuplicateSorts(layout.sorts)) {
      return status(400, { message: "Duplicate sort property" });
    }

    if (hasMultipleKindFilters(layout.filters)) {
      return status(400, { message: "Multiple kind filters" });
    }

    return await scopedDb(async (tx) => {
      const existing = await tx
        .select({ id: workspaceViews.id })
        .from(workspaceViews)
        .where(eq(workspaceViews.workspaceId, workspaceId))
        .for("update");

      if (existing.length >= LIMITS.viewsCount) {
        return status(400, { message: "Views limit reached" });
      }

      const [maxRow] = await tx
        .select({
          max: sql<number>`coalesce(max(${workspaceViews.position}), -1)`,
        })
        .from(workspaceViews)
        .where(eq(workspaceViews.workspaceId, workspaceId));

      const nextPosition = (maxRow?.max ?? -1) + 1;

      const [inserted] = await tx
        .insert(workspaceViews)
        .values({
          id: body.id,
          workspaceId,
          name: body.name,
          layout,
          position: nextPosition,
        })
        .returning();

      if (!inserted) {
        return status(500);
      }

      const view = {
        version: 1 as const,
        id: inserted.id,
        name: inserted.name,
        layout: inserted.layout,
        position: inserted.position,
        createdAt: inserted.createdAt.toISOString(),
      };

      broadcast(workspaceId, {
        type: "invalidate-query",
        data: ["views", workspaceId],
      });

      return view;
    });
  },
);

export default createView;

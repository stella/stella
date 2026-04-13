import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { workspaceViews } from "@/api/db/schema";
import { convertLayout } from "@/api/handlers/views/utils";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { broadcast } from "@/api/lib/sse";

const VIEW_LAYOUT_TYPES = [
  "overview",
  "table",
  "filesystem",
  "kanban",
  "calendar",
  "timeline",
] as const;

const config = {
  permissions: { view: ["update"] },
  params: t.Object({
    viewId: tNanoid,
  }),
  body: t.Object({
    targetType: t.UnionEnum(VIEW_LAYOUT_TYPES),
  }),
} satisfies HandlerConfig;

const convertView = createHandler(
  config,
  async ({
    scopedDb,
    workspaceId,
    params: { viewId },
    body: { targetType },
  }) => {
    const existing = await scopedDb((tx) =>
      tx.query.workspaceViews.findFirst({
        where: {
          id: viewId,
          workspaceId: { eq: workspaceId },
        },
      }),
    );

    if (!existing) {
      return status(404, { message: "View not found" });
    }

    if (existing.layout.type === targetType) {
      return status(400, {
        message: "View is already this layout type",
      });
    }

    const newLayout = convertLayout(existing.layout, targetType);

    await scopedDb((tx) =>
      tx
        .update(workspaceViews)
        .set({ layout: newLayout })
        .where(
          and(
            eq(workspaceViews.id, viewId),
            eq(workspaceViews.workspaceId, workspaceId),
          ),
        ),
    );

    const view = {
      version: 1 as const,
      id: existing.id,
      name: existing.name,
      layout: newLayout,
      position: existing.position,
      createdAt: existing.createdAt.toISOString(),
    };

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["views", workspaceId],
    });

    return view;
  },
);

export default convertView;

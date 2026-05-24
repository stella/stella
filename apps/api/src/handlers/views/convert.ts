import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { workspaceViews } from "@/api/db/schema";
import { convertLayout } from "@/api/handlers/views/utils";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { broadcast } from "@/api/lib/sse";
import { parseViewLayout } from "@/api/lib/views-schema";

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
  params: workspaceParams({ viewId: tSafeId("workspaceView") }),
  body: t.Object({
    targetType: t.UnionEnum(VIEW_LAYOUT_TYPES),
  }),
} satisfies HandlerConfig;

const convertView = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    params: { viewId },
    body: { targetType },
    recordAuditEvent,
  }) {
    if (targetType === "overview") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Cannot convert to overview",
        }),
      );
    }

    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.workspaceViews.findFirst({
          where: {
            id: { eq: viewId },
            workspaceId: { eq: workspaceId },
          },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "View not found" }),
      );
    }

    const existingLayout = parseViewLayout(existing.layout);
    if (existingLayout.type === targetType) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "View is already this layout type",
        }),
      );
    }

    const newLayout = convertLayout(existingLayout, targetType);

    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .update(workspaceViews)
          .set({ layout: newLayout })
          .where(
            and(
              eq(workspaceViews.id, viewId),
              eq(workspaceViews.workspaceId, workspaceId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.VIEW,
          resourceId: viewId,
          changes: {
            layoutType: { old: existingLayout.type, new: targetType },
          },
          metadata: { reason: "convert" },
        });
      }),
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

    return Result.ok(view);
  },
);

export default convertView;

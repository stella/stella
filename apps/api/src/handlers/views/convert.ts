import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  resourceRef,
  RESOURCE_TYPE,
  VIEW_LAYOUT_TYPES,
} from "@stll/api-contract";

import { abortableTx } from "@/api/db/safe-db";
import { workspaceViews } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { legalListsDeployed } from "@/api/lib/lists/deployment";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import { normalizeDefaultViewLayout } from "@/api/lib/views";
import { parseStoredViewLayout } from "@/api/lib/views-schema";
import {
  avtLayoutErrorDetail,
  rejectAvtLayout,
} from "@/api/lib/views/avt-layout";
import { convertLayout } from "@/api/lib/views/utils";

const config = {
  description:
    "Convert one view of a matter to another layout type (table, filesystem, " +
    "kanban, calendar, timeline, or avt: document verification against a " +
    "list's facts, where legal lists are enabled), carrying over as much of its filters and sorts as the " +
    "target layout supports. Converting to overview, or to " +
    "the layout the view already has, is refused. Use views.update to change " +
    "a view's name or the details of its current layout.",
  permissions: { view: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  params: workspaceParams({ viewId: tSafeId("workspaceView") }),
  body: t.Object({
    targetType: t.UnionEnum([...VIEW_LAYOUT_TYPES]),
  }),
} satisfies WorkspaceHandlerConfig;

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

    const existingLayout = normalizeDefaultViewLayout({
      layout: parseStoredViewLayout(existing.layout),
      name: existing.name,
    });
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
      abortableTx(safeDb, async (tx) => {
        const avtRejection = await rejectAvtLayout({
          tx,
          workspaceId,
          layout: newLayout,
          legalListsEnabled: legalListsDeployed(),
        });
        if (avtRejection !== null) {
          throw new HandlerError(avtLayoutErrorDetail(avtRejection));
        }

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

    broadcastWorkspaceResourceUpdated(
      workspaceId,
      resourceRef({ type: RESOURCE_TYPE.WORKSPACE_VIEW, id: viewId }),
    );

    return Result.ok(view);
  },
);

export default convertView;

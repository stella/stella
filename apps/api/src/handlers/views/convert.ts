import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  CONVERTIBLE_VIEW_LAYOUTS,
  resourceRef,
  RESOURCE_TYPE,
} from "@stll/api-contract";

import { abortableTx } from "@/api/db/safe-db";
import { workspaceViews } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  AVT_LAYOUT_FEATURE_ACCESS,
  avtViewAccessStatus,
  isAvtLayoutVisible,
} from "@/api/lib/auth/feature-access/view-eligibility";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  rejectAvtLayout,
  avtLayoutErrorDetail,
} from "@/api/lib/lists/verification/view-layout";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import { normalizeDefaultViewLayout } from "@/api/lib/views";
import { parseStoredViewLayout } from "@/api/lib/views-schema";
import { convertLayout } from "@/api/lib/views/utils";

const config = {
  description:
    "Convert one view of a matter to another layout type (table, filesystem, " +
    "kanban, calendar, or timeline), carrying over as much of its filters and sorts as the " +
    "target layout supports. Converting to overview or correspondence, or to " +
    "the layout the view already has, is refused. Use views.update to change " +
    "a view's name or the details of its current layout.",
  featureAccess: AVT_LAYOUT_FEATURE_ACCESS,
  permissions: { view: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "workspace_schema",
    consumesServices: false,
  },
  params: workspaceParams({ viewId: tSafeId("workspaceView") }),
  body: t.Object({
    targetType: t.UnionEnum([...CONVERTIBLE_VIEW_LAYOUTS]),
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
    featureAccessSnapshot,
    session,
    user,
  }) {
    const avtAccessStatus = avtViewAccessStatus({
      snapshot: featureAccessSnapshot,
      organizationId: session.activeOrganizationId,
      userId: user.id,
    });
    if (targetType === "avt" && avtAccessStatus !== "available") {
      return Result.err(
        new HandlerError({ status: 404, message: "Not found" }),
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

    if (!isAvtLayoutVisible(existing.layout, avtAccessStatus)) {
      return Result.err(
        new HandlerError({ status: 404, message: "Not found" }),
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

    const avtRejection = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        const rejection = await rejectAvtLayout({
          tx,
          workspaceId,
          layout: newLayout,
          legalListsEnabled: isDeploymentFeatureEnabled("FEATURE_LEGAL_LISTS"),
          accessStatus: avtAccessStatus,
        });
        if (rejection !== null) {
          return rejection;
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
        return null;
      }),
    );
    if (avtRejection !== null) {
      return Result.err(new HandlerError(avtLayoutErrorDetail(avtRejection)));
    }

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

import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

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
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import type { ViewLayout } from "@/api/lib/views-schema";
import {
  parseStoredViewLayout,
  parseViewLayout,
  tUpdateViewBodySchema,
} from "@/api/lib/views-schema";
import { resolveTemplateProperties } from "@/api/lib/views/template-properties";
import {
  cleanStalePropertyIds,
  hasDuplicateSorts,
  hasMultipleKindFilters,
} from "@/api/lib/views/utils";

const config = {
  description:
    "Rename one view of a matter or replace its layout. The layout type " +
    "cannot change here, use views.convert for that; duplicate sorts and " +
    "multiple kind filters are refused, columns the new layout needs are " +
    "created when your role may create columns, and references to deleted " +
    "columns are dropped.",
  featureAccess: AVT_LAYOUT_FEATURE_ACCESS,
  permissions: { view: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "workspace_schema",
    consumesServices: false,
  },
  params: workspaceParams({ viewId: tSafeId("workspaceView") }),
  body: tUpdateViewBodySchema,
} satisfies WorkspaceHandlerConfig;

const updateView = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    memberRole,
    params: { viewId },
    body,
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
    if (body.layout?.type === "avt" && avtAccessStatus !== "available") {
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

    let parsedLayout: ViewLayout | undefined;
    if (body.layout !== undefined) {
      parsedLayout = parseViewLayout(body.layout);

      if (hasDuplicateSorts(parsedLayout.sorts)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Duplicate sort property",
          }),
        );
      }
      if (hasMultipleKindFilters(parsedLayout.filters)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Multiple kind filters",
          }),
        );
      }
      const existingLayout = parseStoredViewLayout(existing.layout);
      if (existingLayout.type !== parsedLayout.type) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Cannot change view type",
          }),
        );
      }
    }

    const updates: Partial<{ name: string; layout: ViewLayout }> = {};
    if (body.name !== undefined) {
      updates.name = body.name;
    }
    if (parsedLayout !== undefined) {
      updates.layout = parsedLayout;
    }

    if (Object.keys(updates).length === 0) {
      return Result.ok({});
    }

    const avtRejection = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        if (parsedLayout !== undefined) {
          const rejection = await rejectAvtLayout({
            tx,
            workspaceId,
            layout: parsedLayout,
            legalListsEnabled: isDeploymentFeatureEnabled(
              "FEATURE_LEGAL_LISTS",
            ),
            accessStatus: avtAccessStatus,
          });
          if (rejection !== null) {
            return rejection;
          }

          const resolvedTemplateProperties = await resolveTemplateProperties({
            tx,
            workspaceId,
            layout: parsedLayout,
            templateProperties: body.templateProperties,
            canCreateProperties: hasMemberPermission(memberRole, {
              property: ["create"],
            }),
            recordAuditEvent,
          });
          // Throwing aborts the transaction; `abortableTx` hands the HandlerError
          // back as the failure.
          if (resolvedTemplateProperties.isErr()) {
            throw resolvedTemplateProperties.error;
          }

          cleanStalePropertyIds(
            parsedLayout,
            resolvedTemplateProperties.value.propertyIds,
          );
          updates.layout = parsedLayout;
        }

        await tx
          .update(workspaceViews)
          .set(updates)
          .where(
            and(
              eq(workspaceViews.id, viewId),
              eq(workspaceViews.workspaceId, workspaceId),
            ),
          );

        const changes: Record<string, { old: unknown; new: unknown }> = {};
        if (updates.name !== undefined) {
          changes["name"] = { old: existing.name, new: updates.name };
        }
        if (updates.layout !== undefined) {
          changes["layout"] = {
            old: parseStoredViewLayout(existing.layout),
            new: updates.layout,
          };
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.VIEW,
          resourceId: viewId,
          changes,
        });
        return null;
      }),
    );
    if (avtRejection !== null) {
      return Result.err(new HandlerError(avtLayoutErrorDetail(avtRejection)));
    }

    broadcastWorkspaceResourceUpdated(
      workspaceId,
      resourceRef({ type: RESOURCE_TYPE.WORKSPACE_VIEW, id: viewId }),
    );

    return Result.ok({});
  },
);

export default updateView;

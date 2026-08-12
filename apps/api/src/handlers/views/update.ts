import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import { roles } from "@stll/permissions";

import { abortableTx } from "@/api/db/safe-db";
import { workspaceViews } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import type { ViewLayout } from "@/api/lib/views-schema";
import { parseViewLayout, tUpdateViewBodySchema } from "@/api/lib/views-schema";
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
  permissions: { view: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  params: workspaceParams({ viewId: tSafeId("workspaceView") }),
  body: tUpdateViewBodySchema,
} satisfies HandlerConfig;

const updateView = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    memberRole,
    params: { viewId },
    body,
    recordAuditEvent,
  }) {
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
      const existingLayout = parseViewLayout(existing.layout);
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

    yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        if (parsedLayout !== undefined) {
          const resolvedTemplateProperties = await resolveTemplateProperties({
            tx,
            workspaceId,
            layout: parsedLayout,
            templateProperties: body.templateProperties,
            canCreateProperties: roles[memberRole.role].authorize({
              property: ["create"],
            }).success,
            recordAuditEvent,
          });

          cleanStalePropertyIds(
            parsedLayout,
            resolvedTemplateProperties.propertyIds,
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
            old: parseViewLayout(existing.layout),
            new: updates.layout,
          };
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.VIEW,
          resourceId: viewId,
          changes,
        });
      }),
    );

    broadcastWorkspaceResourceUpdated(
      workspaceId,
      resourceRef({ type: RESOURCE_TYPE.WORKSPACE_VIEW, id: viewId }),
    );

    return Result.ok({});
  },
);

export default updateView;

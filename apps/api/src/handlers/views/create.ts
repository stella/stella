import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import { roles } from "@stll/permissions";

import { abortableTx } from "@/api/db/safe-db";
import { workspaceViews } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import {
  parseViewLayout,
  tCreateViewInputSchema,
} from "@/api/lib/views-schema";
import { resolveTemplateProperties } from "@/api/lib/views/template-properties";
import {
  cleanStalePropertyIds,
  hasDuplicateSorts,
  hasMultipleKindFilters,
} from "@/api/lib/views/utils";

const config = {
  description:
    "Add a view (a tab) to a matter with a name and a layout. Duplicate " +
    "sorts and multiple kind filters are refused, the columns the layout " +
    "needs are created when your role may create columns, and references to " +
    "columns that do not exist are dropped. A matter may hold only one " +
    "overview view, and a fixed maximum of views in total.",
  permissions: { view: ["create"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: tCreateViewInputSchema,
} satisfies HandlerConfig;

const createView = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    memberRole,
    body,
    recordAuditEvent,
  }) {
    const layout = parseViewLayout(body.layout);

    if (hasDuplicateSorts(layout.sorts)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Duplicate sort property" }),
      );
    }

    if (hasMultipleKindFilters(layout.filters)) {
      return Result.err(
        new HandlerError({ status: 400, message: "Multiple kind filters" }),
      );
    }

    const txResult = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        const existing = await tx
          .select({ id: workspaceViews.id, layout: workspaceViews.layout })
          .from(workspaceViews)
          .where(eq(workspaceViews.workspaceId, workspaceId))
          .for("update");

        const hasOverviewView = existing.some(
          (view) => parseViewLayout(view.layout).type === "overview",
        );

        if (layout.type === "overview" && hasOverviewView) {
          throw new HandlerError({
            status: 400,
            message: "Overview view already exists",
          });
        }

        if (existing.length >= LIMITS.viewsCount) {
          throw new HandlerError({
            status: 400,
            message: "Views limit reached",
          });
        }

        const resolvedTemplateProperties = await resolveTemplateProperties({
          tx,
          workspaceId,
          layout,
          templateProperties: body.templateProperties,
          canCreateProperties: roles[memberRole.role].authorize({
            property: ["create"],
          }).success,
          recordAuditEvent,
        });

        cleanStalePropertyIds(layout, resolvedTemplateProperties.propertyIds);

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
          // Resolving the template columns above may have created columns,
          // dependency rows, and audit events; returning here would commit them
          // without the view they belong to.
          throw new HandlerError({
            status: 500,
            message: "Failed to create view",
          });
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.VIEW,
          resourceId: inserted.id,
          changes: {
            created: {
              old: null,
              new: {
                name: inserted.name,
                layoutType: layout.type,
                position: inserted.position,
              },
            },
          },
        });

        return {
          view: {
            version: 1 as const,
            id: inserted.id,
            name: inserted.name,
            layout: inserted.layout,
            position: inserted.position,
            createdAt: inserted.createdAt.toISOString(),
          },
        };
      }),
    );

    broadcastWorkspaceResourceUpdated(
      workspaceId,
      resourceRef({ type: RESOURCE_TYPE.WORKSPACE_VIEW, id: body.id }),
    );

    return Result.ok(txResult.view);
  },
);

export default createView;

import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";

import {
  isSingleViewLayout,
  resourceRef,
  RESOURCE_TYPE,
  type ViewLayoutType,
} from "@stll/api-contract";

import { abortableTx } from "@/api/db/safe-db";
import {
  WORKSPACE_VIEWS_CORRESPONDENCE_INDEX,
  workspaceViews,
} from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  AVT_LAYOUT_FEATURE_ACCESS,
  avtViewAccessStatus,
} from "@/api/lib/auth/feature-access/view-eligibility";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  rejectAvtLayout,
  avtLayoutErrorDetail,
} from "@/api/lib/lists/verification/view-layout";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import {
  parseStoredViewLayout,
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
    "overview view and one correspondence view, and a fixed maximum of " +
    "views in total.",
  featureAccess: AVT_LAYOUT_FEATURE_ACCESS,
  permissions: { view: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "workspace_schema",
    consumesServices: false,
  },
  body: tCreateViewInputSchema,
} satisfies WorkspaceHandlerConfig;

const singleViewConflict = (type: ViewLayoutType): HandlerError =>
  new HandlerError({
    status: 400,
    message: `A matter holds only one ${type} view`,
  });

const createView = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    memberRole,
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
    const layout = parseViewLayout(body.layout);

    if (layout.type === "avt" && avtAccessStatus !== "available") {
      return Result.err(
        new HandlerError({ status: 404, message: "Not found" }),
      );
    }

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

    const txAttempt = await abortableTx(safeDb, async (tx) => {
      const existing = await tx
        .select({ id: workspaceViews.id, layout: workspaceViews.layout })
        .from(workspaceViews)
        .where(eq(workspaceViews.workspaceId, workspaceId))
        .for("update");

      if (
        isSingleViewLayout(layout.type) &&
        existing.some(
          (view) => parseStoredViewLayout(view.layout).type === layout.type,
        )
      ) {
        throw singleViewConflict(layout.type);
      }

      if (existing.length >= LIMITS.viewsCount) {
        throw new HandlerError({
          status: 400,
          message: "Views limit reached",
        });
      }

      const avtRejection = await rejectAvtLayout({
        tx,
        workspaceId,
        layout,
        legalListsEnabled: isDeploymentFeatureEnabled("FEATURE_LEGAL_LISTS"),
        accessStatus: avtAccessStatus,
      });
      if (avtRejection !== null) {
        // Nothing is written yet, so returning commits no partial view.
        return { type: "rejected" as const, rejection: avtRejection };
      }

      const resolvedTemplateProperties = await resolveTemplateProperties({
        tx,
        workspaceId,
        layout,
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
        layout,
        resolvedTemplateProperties.value.propertyIds,
      );

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
        type: "created" as const,
        view: {
          version: 1 as const,
          id: inserted.id,
          name: inserted.name,
          layout: inserted.layout,
          position: inserted.position,
          createdAt: inserted.createdAt.toISOString(),
        },
      };
    });
    // The check above cannot see a view a concurrent create is inserting;
    // the unique index can, and its refusal reads as the same conflict.
    if (
      txAttempt.isErr() &&
      isPgConstraintError(
        txAttempt.error,
        PG_ERROR.UNIQUE_VIOLATION,
        WORKSPACE_VIEWS_CORRESPONDENCE_INDEX,
      )
    ) {
      return Result.err(singleViewConflict(layout.type));
    }
    const txResult = yield* txAttempt;
    if (txResult.type === "rejected") {
      return Result.err(
        new HandlerError(avtLayoutErrorDetail(txResult.rejection)),
      );
    }

    broadcastWorkspaceResourceUpdated(
      workspaceId,
      resourceRef({ type: RESOURCE_TYPE.WORKSPACE_VIEW, id: body.id }),
    );

    return Result.ok(txResult.view);
  },
);

export default createView;

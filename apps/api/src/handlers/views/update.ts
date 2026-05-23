import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { roles } from "@stll/permissions";

import { workspaceViews } from "@/api/db/schema";
import { resolveTemplateProperties } from "@/api/handlers/view-templates/properties";
import {
  cleanStalePropertyIds,
  hasDuplicateSorts,
  hasMultipleKindFilters,
} from "@/api/handlers/views/utils";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
} from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { broadcast } from "@/api/lib/sse";
import type { ViewLayout } from "@/api/lib/views-schema";
import { parseViewLayout, tUpdateViewBodySchema } from "@/api/lib/views-schema";

const config = {
  permissions: { view: ["update"] },
  params: workspaceParams({ viewId: tSafeId("workspaceView") }),
  body: tUpdateViewBodySchema,
} satisfies HandlerConfig;

const updateView = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    memberRole,
    session,
    user,
    request,
    server,
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
      return Result.ok(undefined);
    }

    const updateResult = yield* Result.await(
      safeDb(async (tx) => {
        if (parsedLayout !== undefined) {
          const resolvedTemplateProperties = await resolveTemplateProperties({
            tx,
            workspaceId,
            layout: parsedLayout,
            templateProperties: body.templateProperties,
            canCreateProperties: roles[memberRole.role].authorize({
              property: ["create"],
            }).success,
            auditContext: createAuditContext({
              organizationId: session.activeOrganizationId,
              workspaceId,
              userId: user.id,
              request,
              server,
            }),
          });

          if (!resolvedTemplateProperties.ok) {
            return resolvedTemplateProperties;
          }
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

        return { ok: true as const };
      }),
    );

    if (!updateResult.ok) {
      return Result.err(
        new HandlerError({
          status: updateResult.status,
          message: updateResult.message,
        }),
      );
    }

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["views", workspaceId],
    });

    return Result.ok(undefined);
  },
);

export default updateView;

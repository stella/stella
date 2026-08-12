import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { workspaceViewTemplates } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  assertPropertyDependencyReadWithinLimit,
  propertyDependencyReadLimit,
} from "@/api/lib/properties/dependency-limits";
import { parseViewLayout, tViewLayoutSchema } from "@/api/lib/views-schema";
import { collectTemplateProperties } from "@/api/lib/views/template-properties";
import {
  cleanStalePropertyIds,
  hasDuplicateSorts,
  hasMultipleKindFilters,
} from "@/api/lib/views/utils";

const createViewTemplateBodySchema = t.Object(
  {
    name: tDefaultVarchar,
    layout: tViewLayoutSchema,
  },
  { additionalProperties: false },
);

const config = {
  description:
    "Save a view layout as a personal view template, the blueprint used to " +
    "create views in other matters. Duplicate sorts and multiple kind " +
    "filters are refused, references to columns that do not exist are " +
    "dropped, and the columns the layout needs are captured so they can be " +
    "recreated wherever the template is applied. Names are unique per user, " +
    "so a repeat name is a 409, and the per-user template limit applies.",
  permissions: { view: ["create"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: createViewTemplateBodySchema,
} satisfies HandlerConfig;

const createViewTemplate = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    session,
    user,
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

    const insertResult = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${session.activeOrganizationId}), hashtext(${user.id}))`,
        );

        const existingCount = await tx.$count(
          workspaceViewTemplates,
          and(
            eq(
              workspaceViewTemplates.organizationId,
              session.activeOrganizationId,
            ),
            eq(workspaceViewTemplates.userId, user.id),
          ),
        );

        if (existingCount >= LIMITS.viewTemplatesPerUser) {
          throw new HandlerError({
            status: 400,
            message: "View template limit reached",
          });
        }

        const workspaceProperties = await tx.query.properties.findMany({
          where: { workspaceId: { eq: workspaceId } },
          columns: {
            id: true,
            name: true,
            content: true,
            tool: true,
            system: true,
            role: true,
          },
          limit: LIMITS.propertiesCount,
        });

        const workspaceDependencies =
          await tx.query.propertyDependencies.findMany({
            where: { workspaceId: { eq: workspaceId } },
            columns: {
              propertyId: true,
              dependsOnPropertyId: true,
              condition: true,
            },
            limit: propertyDependencyReadLimit("perWorkspace"),
          });
        assertPropertyDependencyReadWithinLimit(
          workspaceDependencies.length,
          "perWorkspace",
        );
        cleanStalePropertyIds(
          layout,
          workspaceProperties.map((property) => property.id),
        );
        const templateProperties = collectTemplateProperties({
          layout,
          properties: workspaceProperties,
          dependencies: workspaceDependencies,
        });

        const rows = await tx
          .insert(workspaceViewTemplates)
          .values({
            organizationId: session.activeOrganizationId,
            userId: user.id,
            name: body.name,
            layout,
            templateProperties,
          })
          .onConflictDoNothing({
            target: [
              workspaceViewTemplates.organizationId,
              workspaceViewTemplates.userId,
              workspaceViewTemplates.name,
            ],
          })
          .returning({
            id: workspaceViewTemplates.id,
          });

        const row = rows.at(0);
        if (!row) {
          throw new HandlerError({
            status: 409,
            message: "A view template with this name already exists",
          });
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.VIEW_TEMPLATE,
          resourceId: row.id,
          changes: {
            created: {
              old: null,
              new: {
                name: body.name,
                layoutType: layout.type,
                templatePropertyCount: templateProperties.length,
              },
            },
          },
        });

        return { id: row.id };
      }),
    );

    return Result.ok({ id: insertResult.id });
  },
);

export default createViewTemplate;

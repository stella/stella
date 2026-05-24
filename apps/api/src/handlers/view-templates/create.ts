import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { workspaceViewTemplates } from "@/api/db/schema";
import { collectTemplateProperties } from "@/api/handlers/view-templates/properties";
import {
  cleanStalePropertyIds,
  hasDuplicateSorts,
  hasMultipleKindFilters,
} from "@/api/handlers/views/utils";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { parseViewLayout, tViewLayoutSchema } from "@/api/lib/views-schema";

const createViewTemplateBodySchema = t.Object(
  {
    name: tDefaultVarchar,
    layout: tViewLayoutSchema,
  },
  { additionalProperties: false },
);

const config = {
  permissions: { view: ["create"] },
  body: createViewTemplateBodySchema,
} satisfies HandlerConfig;

const createViewTemplate = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, session, user, body }) {
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
      safeDb(async (tx) => {
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
          return {
            ok: false as const,
            status: 400 as const,
            message: "View template limit reached",
          };
        }

        const workspaceProperties = await tx.query.properties.findMany({
          where: { workspaceId: { eq: workspaceId } },
          columns: {
            id: true,
            name: true,
            content: true,
            tool: true,
            system: true,
          },
        });
        const workspaceDependencies =
          await tx.query.propertyDependencies.findMany({
            where: { workspaceId: { eq: workspaceId } },
            columns: {
              propertyId: true,
              dependsOnPropertyId: true,
              condition: true,
            },
          });
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
          return {
            ok: false as const,
            status: 409 as const,
            message: "A view template with this name already exists",
          };
        }

        return { ok: true as const, id: row.id };
      }),
    );

    if (!insertResult.ok) {
      return Result.err(
        new HandlerError({
          status: insertResult.status,
          message: insertResult.message,
        }),
      );
    }

    return Result.ok({ id: insertResult.id });
  },
);

export default createViewTemplate;

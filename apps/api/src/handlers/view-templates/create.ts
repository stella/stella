import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
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
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { PG_ERROR } from "@/api/lib/pg-error";
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

    const existingCount = yield* Result.await(
      safeDb((tx) =>
        tx.$count(
          workspaceViewTemplates,
          and(
            eq(
              workspaceViewTemplates.organizationId,
              session.activeOrganizationId,
            ),
            eq(workspaceViewTemplates.userId, user.id),
          ),
        ),
      ),
    );

    if (existingCount >= LIMITS.viewTemplatesPerUser) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "View template limit reached",
        }),
      );
    }

    const workspaceProperties = yield* Result.await(
      safeDb((tx) =>
        tx.query.properties.findMany({
          where: { workspaceId: { eq: workspaceId } },
          columns: {
            id: true,
            name: true,
            content: true,
            tool: true,
            system: true,
          },
        }),
      ),
    );
    const workspaceDependencies = yield* Result.await(
      safeDb((tx) =>
        tx.query.propertyDependencies.findMany({
          where: { workspaceId: { eq: workspaceId } },
          columns: {
            propertyId: true,
            dependsOnPropertyId: true,
            condition: true,
          },
        }),
      ),
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

    const insertResult = await safeDb((tx) =>
      tx
        .insert(workspaceViewTemplates)
        .values({
          organizationId: session.activeOrganizationId,
          userId: user.id,
          name: body.name,
          layout,
          templateProperties,
        })
        .returning({
          id: workspaceViewTemplates.id,
        }),
    );

    if (Result.isError(insertResult)) {
      if (
        DatabaseError.is(insertResult.error) &&
        insertResult.error.code === PG_ERROR.UNIQUE_VIOLATION
      ) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "A view template with this name already exists",
          }),
        );
      }
      return Result.err(insertResult.error);
    }

    const row = insertResult.value.at(0);
    if (!row) {
      panic("Failed to create view template");
    }

    return Result.ok({ id: row.id });
  },
);

export default createViewTemplate;

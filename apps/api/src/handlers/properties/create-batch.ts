import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { properties, propertyDependencies } from "@/api/db/schema";
import {
  buildPropertyParts,
  createPropertyBodySchema,
} from "@/api/handlers/properties/create-schema";
import { lockWorkspacePropertyWrites } from "@/api/handlers/properties/property-lock";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: { property: ["create"] },
  body: t.Object({
    items: t.Array(createPropertyBodySchema, { minItems: 1, maxItems: 10 }),
  }),
} satisfies HandlerConfig;

const createPropertiesBatch = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const builtItems = body.items.map((item) => ({
      name: item.name,
      built: buildPropertyParts(item),
    }));

    for (const { built } of builtItems) {
      if ("status" in built) {
        return Result.err(
          new HandlerError({ status: built.status, message: built.message }),
        );
      }
    }

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        await lockWorkspacePropertyWrites(tx, workspaceId);
        const existingRows = await tx
          .select({ id: properties.id })
          .from(properties)
          .where(eq(properties.workspaceId, workspaceId));

        if (existingRows.length + body.items.length > LIMITS.propertiesCount) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Properties limit reached",
          };
        }

        const allDependencyIds = new Set<SafeId<"property">>();
        for (const { built } of builtItems) {
          if ("status" in built) {
            continue;
          }
          for (const dep of built.dependencies) {
            allDependencyIds.add(dep.dependsOnPropertyId);
          }
        }
        if (allDependencyIds.size > 0) {
          const dependencyRows = await tx.query.properties.findMany({
            where: (table, { and, eq, inArray }) =>
              and(
                eq(table.workspaceId, workspaceId),
                inArray(table.id, [...allDependencyIds]),
              ),
            columns: { id: true },
          });
          if (dependencyRows.length !== allDependencyIds.size) {
            return {
              ok: false as const,
              status: 422 as const,
              message: "Dependency property not found",
            };
          }
        }

        const insertedIds: string[] = [];

        for (const { name, built } of builtItems) {
          if ("status" in built) {
            continue;
          }
          const { content, tool, dependencies } = built;
          const initialStatus = tool.type === "ai-model" ? "stale" : "fresh";

          const [inserted] = await tx
            .insert(properties)
            .values({
              workspaceId,
              name,
              content,
              tool,
              status: initialStatus,
            })
            .returning({ id: properties.id });

          if (!inserted) {
            return {
              ok: false as const,
              status: 500 as const,
              message: "Failed to create property",
            };
          }

          if (dependencies.length > 0) {
            await tx.insert(propertyDependencies).values(
              dependencies.map(({ dependsOnPropertyId, condition }) => ({
                workspaceId,
                propertyId: inserted.id,
                dependsOnPropertyId,
                condition,
              })),
            );
          }

          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.PROPERTY,
            resourceId: inserted.id,
            changes: {
              created: {
                old: null,
                new: {
                  name,
                  contentType: content.type,
                  toolType: tool.type,
                },
              },
            },
          });

          insertedIds.push(inserted.id);
        }

        return { ok: true as const, ids: insertedIds };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: txResult.status,
          message: txResult.message,
        }),
      );
    }

    return Result.ok({ ids: txResult.ids });
  },
);

export default createPropertiesBatch;

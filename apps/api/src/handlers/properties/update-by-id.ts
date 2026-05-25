import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import { properties, propertyDependencies } from "@/api/db/schema";
import {
  aiModelToolSchema,
  manualInputToolSchema,
  propertyConditionSchema,
  propertyContentSchema,
} from "@/api/db/schema-validators";
import type { PropertyTool } from "@/api/db/schema-validators";
import { comparePropertiesForStale } from "@/api/handlers/properties/utils";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  tDefaultVarchar,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { serializeAITool } from "@/api/lib/markdown/ai-tool";

type PropertyWithDeps = {
  id: SafeId<"property">;
  dependencies: { dependsOnPropertyId: SafeId<"property"> }[];
};

/**
 * Collect all transitive dependents of `rootId` via BFS.
 * Returns the set of property IDs that transitively depend
 * on `rootId` (excludes `rootId` itself).
 */
const getTransitiveDependents = (
  rootId: SafeId<"property">,
  allProperties: PropertyWithDeps[],
): Set<SafeId<"property">> => {
  const dependents = new Map<SafeId<"property">, SafeId<"property">[]>();
  for (const prop of allProperties) {
    for (const dep of prop.dependencies) {
      const list = dependents.get(dep.dependsOnPropertyId);
      if (list) {
        list.push(prop.id);
      } else {
        dependents.set(dep.dependsOnPropertyId, [prop.id]);
      }
    }
  }

  const visited = new Set<SafeId<"property">>();
  const queue = dependents.get(rootId) ?? [];

  for (const id of queue) {
    if (visited.has(id)) {
      continue;
    }
    visited.add(id);
    for (const next of dependents.get(id) ?? []) {
      queue.push(next);
    }
  }

  return visited;
};

const hasCircularDependency = ({
  propertyId,
  allProperties,
  proposedInputs,
}: {
  propertyId: SafeId<"property">;
  allProperties: PropertyWithDeps[];
  proposedInputs: SafeId<"property">[];
}): boolean => {
  const dependencyGraph = new Map<SafeId<"property">, SafeId<"property">[]>();

  for (const property of allProperties) {
    if (property.id === propertyId) {
      continue;
    }

    dependencyGraph.set(
      property.id,
      property.dependencies.map((d) => d.dependsOnPropertyId),
    );
  }

  dependencyGraph.set(propertyId, proposedInputs);

  const detectCycle = (
    startId: SafeId<"property">,
    visited: Set<SafeId<"property">>,
  ): boolean => {
    if (startId === propertyId) {
      return true;
    }

    if (visited.has(startId)) {
      return false;
    }

    visited.add(startId);

    for (const inputId of dependencyGraph.get(startId) ?? []) {
      if (detectCycle(inputId, visited)) {
        return true;
      }
    }

    return false;
  };

  for (const inputId of proposedInputs) {
    if (inputId === propertyId) {
      return true;
    }

    if (detectCycle(inputId, new Set())) {
      return true;
    }
  }

  return false;
};

const updatePropertyBodySchema = t.Object({
  name: tDefaultVarchar,
  content: propertyContentSchema,
  tool: t.Union([
    t.Intersect([
      aiModelToolSchema,
      t.Object({
        dependencies: t.Array(
          t.Object({
            dependsOnPropertyId: tSafeId("property"),
            condition: t.Nullable(propertyConditionSchema),
          }),
        ),
      }),
    ]),
    manualInputToolSchema,
  ]),
});

const config = {
  permissions: { property: ["update"] },
  params: workspaceParams({ propertyId: tSafeId("property") }),
  body: updatePropertyBodySchema,
} satisfies HandlerConfig;

const updateProperty = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    params: { propertyId },
    body,
    recordAuditEvent,
  }) {
    const { name, content } = body;
    const tool =
      body.tool.type === "ai-model" ? serializeAITool(body.tool) : body.tool;

    if (content.type === "file" && tool.type !== "manual-input") {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "File properties must have a manual input tool",
        }),
      );
    }

    const dependencies =
      body.tool.type === "ai-model" ? body.tool.dependencies : [];

    // Strip dependencies from the tool for DB storage
    const dbTool: PropertyTool =
      tool.type === "ai-model"
        ? {
            version: tool.version,
            type: tool.type,
            prompt: tool.prompt,
          }
        : tool;

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const propertyRows = await tx
          .select({
            id: properties.id,
            name: properties.name,
            content: properties.content,
            tool: properties.tool,
            status: properties.status,
          })
          .from(properties)
          .where(
            and(
              eq(properties.id, propertyId),
              eq(properties.workspaceId, workspaceId),
            ),
          )
          .for("update");
        const oldProperty = propertyRows.at(0);

        if (!oldProperty) {
          return {
            ok: false as const,
            status: 404 as const,
            message: "Property not found",
          };
        }

        const oldDependencies = await tx.query.propertyDependencies.findMany({
          where: {
            propertyId: { eq: propertyId },
            workspaceId: { eq: workspaceId },
          },
          columns: {
            dependsOnPropertyId: true,
            condition: true,
          },
        });

        const isStale = comparePropertiesForStale({
          oldProperty: {
            content: oldProperty.content,
            tool:
              oldProperty.tool.type === "ai-model"
                ? {
                    ...oldProperty.tool,
                    dependencies: oldDependencies,
                  }
                : oldProperty.tool,
          },
          newProperty: { content, tool },
        });

        const allProperties =
          body.tool.type === "ai-model" || isStale
            ? await tx.query.properties.findMany({
                where: { workspaceId: { eq: workspaceId } },
                columns: { id: true },
                with: {
                  dependencies: {
                    columns: { dependsOnPropertyId: true },
                  },
                },
              })
            : [];

        if (
          body.tool.type === "ai-model" &&
          hasCircularDependency({
            propertyId,
            allProperties,
            proposedInputs: body.tool.dependencies.map(
              (d) => d.dependsOnPropertyId,
            ),
          })
        ) {
          return {
            ok: false as const,
            status: 422 as const,
            message: "Circular dependency detected",
          };
        }

        const updatePropertyQuery = tx
          .update(properties)
          .set({
            name,
            content,
            tool: dbTool,
            status: isStale ? "stale" : "fresh",
          })
          .where(eq(properties.id, propertyId));

        const deleteDeps = tx
          .delete(propertyDependencies)
          .where(eq(propertyDependencies.propertyId, propertyId));

        const promises: Promise<unknown>[] = [updatePropertyQuery, deleteDeps];

        if (isStale) {
          const staleIds = getTransitiveDependents(propertyId, allProperties);

          if (staleIds.size > 0) {
            promises.push(
              tx
                .update(properties)
                .set({ status: "stale" })
                .where(inArray(properties.id, [...staleIds])),
            );
          }
        }

        await Promise.all(promises);

        if (dependencies.length > 0) {
          await tx.insert(propertyDependencies).values(
            dependencies.map(({ dependsOnPropertyId, condition }) => ({
              workspaceId,
              propertyId,
              dependsOnPropertyId,
              condition,
            })),
          );
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.PROPERTY,
          resourceId: propertyId,
          changes: {
            name: { old: oldProperty.name, new: name },
            content: { old: oldProperty.content, new: content },
            tool: { old: oldProperty.tool, new: dbTool },
            dependencies: { old: oldDependencies, new: dependencies },
            status: {
              old: oldProperty.status,
              new: isStale ? "stale" : "fresh",
            },
          },
        });

        return { ok: true as const };
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

    return Result.ok(undefined);
  },
);

export default updateProperty;

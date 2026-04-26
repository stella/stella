import { Result } from "better-result";
import { eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import { properties, propertyDependencies } from "@/api/db/schema";
import {
  aiModelToolSchema,
  manualInputToolSchema,
  propertyConditionSchema,
  propertyContentSchema,
} from "@/api/db/schema-validators";
import type { PropertyTool } from "@/api/db/schema-validators";
import {
  comparePropertiesForStale,
  validatePropertyInputs,
} from "@/api/handlers/properties/utils";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
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
  async function* ({ safeDb, workspaceId, params: { propertyId }, body }) {
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

    const oldProperty = yield* Result.await(
      safeDb((tx) =>
        tx.query.properties.findFirst({
          where: { id: { eq: propertyId }, workspaceId: { eq: workspaceId } },
          with: {
            dependencies: {
              columns: {
                dependsOnPropertyId: true,
                condition: true,
              },
            },
          },
        }),
      ),
    );

    if (!oldProperty) {
      return Result.err(
        new HandlerError({ status: 404, message: "Property not found" }),
      );
    }

    const isStale = comparePropertiesForStale({
      oldProperty: {
        content: oldProperty.content,
        tool:
          oldProperty.tool.type === "ai-model"
            ? {
                ...oldProperty.tool,
                dependencies: oldProperty.dependencies,
              }
            : oldProperty.tool,
      },
      newProperty: { content, tool },
    });

    if (body.tool.type === "ai-model") {
      const validation = yield* validatePropertyInputs({
        safeDb,
        propertyId,
        workspaceId,
        proposedInputs: body.tool.dependencies.map(
          (d) => d.dependsOnPropertyId,
        ),
      });

      if (Result.isError(validation)) {
        return Result.err(
          new HandlerError({
            status: 422,
            message: "Circular dependency detected",
          }),
        );
      }
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

    yield* Result.await(
      safeDb(async (tx) => {
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
          const allProperties = await tx.query.properties.findMany({
            where: { workspaceId: { eq: workspaceId } },
            columns: { id: true },
            with: {
              dependencies: {
                columns: { dependsOnPropertyId: true },
              },
            },
          });

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
      }),
    );

    return Result.ok(undefined);
  },
);

export default updateProperty;

import { Result } from "better-result";
import { eq, inArray } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { properties, propertyDependencies } from "@/api/db/schema";
import {
  aiModelToolSchema,
  manualInputToolSchema,
  propertyConditionSchema,
  propertyContentSchema,
  type PropertyTool,
} from "@/api/db/schema-validators";
import {
  comparePropertiesForStale,
  validatePropertyInputs,
} from "@/api/handlers/properties/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { serializeAITool } from "@/api/lib/markdown/ai-tool";

type PropertyWithDeps = {
  id: string;
  dependencies: { dependsOnPropertyId: string }[];
};

/**
 * Collect all transitive dependents of `rootId` via BFS.
 * Returns the set of property IDs that transitively depend
 * on `rootId` (excludes `rootId` itself).
 */
const getTransitiveDependents = (
  rootId: string,
  allProperties: PropertyWithDeps[],
): Set<string> => {
  const dependents = new Map<string, string[]>();
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

  const visited = new Set<string>();
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

export const updatePropertyBodySchema = t.Object({
  name: tDefaultVarchar,
  content: propertyContentSchema,
  tool: t.Union([
    t.Intersect([
      aiModelToolSchema,
      t.Object({
        dependencies: t.Array(
          t.Object({
            dependsOnPropertyId: tNanoid,
            condition: t.Nullable(propertyConditionSchema),
          }),
        ),
      }),
    ]),
    manualInputToolSchema,
  ]),
});

export type UpdatePropertyBodySchema = Static<typeof updatePropertyBodySchema>;

type UpdatePropertyHandlerProps = {
  workspaceId: SafeId<"workspace">;
  propertyId: string;
  body: UpdatePropertyBodySchema;
};

export const updatePropertyHandler = async ({
  workspaceId,
  propertyId,
  body,
}: UpdatePropertyHandlerProps) => {
  const { name, content } = body;
  const tool =
    body.tool.type === "ai-model" ? serializeAITool(body.tool) : body.tool;

  if (content.type === "file" && tool.type !== "manual-input") {
    return status(422, {
      message: "File properties must have a manual input tool",
    });
  }

  const oldProperty = await db.query.properties.findFirst({
    where: { id: propertyId, workspaceId: { eq: workspaceId } },
    with: {
      dependencies: {
        columns: {
          dependsOnPropertyId: true,
          condition: true,
        },
      },
    },
  });

  if (!oldProperty) {
    return status(404);
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

  if (tool.type === "ai-model") {
    const validation = await validatePropertyInputs({
      propertyId,
      workspaceId,
      proposedInputs: tool.dependencies.map((d) => d.dependsOnPropertyId),
    });

    if (Result.isError(validation)) {
      return status(422, {
        message: "Circular dependency detected",
        cycle: validation.error,
      });
    }
  }

  const dependencies = tool.type === "ai-model" ? tool.dependencies : [];

  // Strip dependencies from the tool for DB storage
  const dbTool: PropertyTool =
    tool.type === "ai-model"
      ? {
          version: tool.version,
          type: tool.type,
          prompt: tool.prompt,
        }
      : tool;

  await db.transaction(async (tx) => {
    const updateProperty = tx
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

    const promises: Promise<unknown>[] = [updateProperty, deleteDeps];

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
          propertyId,
          dependsOnPropertyId,
          condition,
        })),
      );
    }
  });

  return;
};

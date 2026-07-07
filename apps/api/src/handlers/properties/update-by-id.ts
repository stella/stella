import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import { properties, propertyDependencies } from "@/api/db/schema";
import type { PropertyRole } from "@/api/db/schema";
import {
  aiModelToolSchema,
  manualInputToolSchema,
  propertyContentSchema,
} from "@/api/db/schema-validators";
import type { PropertyContent, PropertyTool } from "@/api/db/schema-validators";
import {
  DOCUMENT_TYPE_CLASSIFIER_ROLE,
  isDocumentTypeClassifierProperty,
} from "@/api/handlers/properties/create-schema";
import { lockWorkspacePropertyWrites } from "@/api/handlers/properties/property-lock";
import { comparePropertiesForStale } from "@/api/handlers/properties/utils";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tConditionNode } from "@/api/lib/conditions/contract";
import {
  tDefaultVarchar,
  tSafeId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { serializeAITool } from "@/api/lib/markdown/ai-tool";

type PropertyWithDeps = {
  id: SafeId<"property">;
  name: string;
  content: PropertyContent;
  tool: PropertyTool;
  role: PropertyRole | null;
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
            condition: t.Nullable(tConditionNode),
          }),
        ),
      }),
    ]),
    manualInputToolSchema,
  ]),
});

const config = {
  permissions: { property: ["update"] },
  mcp: { type: "pending" },
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

    if (
      (content.type === "single-select" || content.type === "multi-select") &&
      content.fallback !== null &&
      !content.options.some((option) => option.value === content.fallback)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Fallback must match one of the supplied options",
        }),
      );
    }

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
        await lockWorkspacePropertyWrites(tx, workspaceId);
        const propertyRows = await tx
          .select({
            id: properties.id,
            name: properties.name,
            content: properties.content,
            tool: properties.tool,
            role: properties.role,
            status: properties.status,
            playbookDefinitionId: properties.playbookDefinitionId,
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

        const nextRole = isDocumentTypeClassifierProperty({
          content,
          name,
          role:
            oldProperty.role === DOCUMENT_TYPE_CLASSIFIER_ROLE
              ? DOCUMENT_TYPE_CLASSIFIER_ROLE
              : null,
          tool: dbTool,
        })
          ? DOCUMENT_TYPE_CLASSIFIER_ROLE
          : null;
        const isAcquiringClassifierRole =
          oldProperty.role !== DOCUMENT_TYPE_CLASSIFIER_ROLE &&
          nextRole === DOCUMENT_TYPE_CLASSIFIER_ROLE;

        // SAFETY: one property's dependencies; each points to another workspace property, bounded by LIMITS.propertiesCount
        // eslint-disable-next-line require-query-limit/require-query-limit
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
            // Manual-input and verdict columns both compare as a plain manual
            // single-select; the update body cannot set a verdict tool, so an
            // existing verdict is treated like a manual column for staleness.
            tool:
              oldProperty.tool.type === "ai-model"
                ? {
                    ...oldProperty.tool,
                    dependencies: oldDependencies,
                  }
                : { version: 1, type: "manual-input" },
          },
          newProperty: { content, tool },
        });

        const allProperties =
          body.tool.type === "ai-model" || isStale
            ? await tx.query.properties.findMany({
                where: { workspaceId: { eq: workspaceId } },
                columns: {
                  id: true,
                  name: true,
                  content: true,
                  tool: true,
                  role: true,
                },
                limit: LIMITS.propertiesCount,
                with: {
                  dependencies: {
                    columns: { dependsOnPropertyId: true },
                  },
                },
              })
            : [];

        if (
          nextRole !== null &&
          allProperties.some((property) => {
            if (property.id === propertyId) {
              return false;
            }

            if (property.role === DOCUMENT_TYPE_CLASSIFIER_ROLE) {
              return isDocumentTypeClassifierProperty({
                content: property.content,
                name: property.name,
                role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
                tool: property.tool,
              });
            }

            if (!isAcquiringClassifierRole) {
              return false;
            }

            return isDocumentTypeClassifierProperty({
              content: property.content,
              name: property.name,
              role: null,
              tool: property.tool,
            });
          })
        ) {
          return {
            ok: false as const,
            status: 422 as const,
            message: "Document type classifier already exists",
          };
        }

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
            role: nextRole,
            status: isStale ? "stale" : "fresh",
          })
          .where(eq(properties.id, propertyId));

        // Playbook-materialized manual ASK columns carry classifier gate rows
        // that the composer's update body cannot round-trip; deleting and
        // reinserting from an empty `dependencies` here would wipe the gate and
        // leak the column into every document-type group. Preserve the existing
        // rows on a manual save of a playbook-owned property.
        const preserveDependencies =
          oldProperty.playbookDefinitionId !== null &&
          body.tool.type === "manual-input";

        const promises: Promise<unknown>[] = [updatePropertyQuery];

        if (!preserveDependencies) {
          promises.push(
            tx
              .delete(propertyDependencies)
              .where(eq(propertyDependencies.propertyId, propertyId)),
          );
        }

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
            role: { old: oldProperty.role, new: nextRole },
            dependencies: {
              old: oldDependencies,
              new: preserveDependencies ? oldDependencies : dependencies,
            },
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

    return Result.ok({});
  },
);

export default updateProperty;

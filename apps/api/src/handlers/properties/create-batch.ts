import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import { properties, propertyDependencies } from "@/api/db/schema";
import {
  DOCUMENT_TYPE_CLASSIFIER_ROLE,
  buildPropertyParts,
  createPropertyBodySchema,
  isDocumentTypeClassifierProperty,
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
  mcp: { type: "capability", reason: "workspace_schema" },
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
          .select({
            id: properties.id,
            name: properties.name,
            content: properties.content,
            tool: properties.tool,
            role: properties.role,
          })
          .from(properties)
          .where(eq(properties.workspaceId, workspaceId));

        if (existingRows.length + body.items.length > LIMITS.propertiesCount) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Properties limit reached",
          };
        }

        const createsDocumentTypeClassifier = builtItems.filter(
          ({ built }) =>
            !("status" in built) &&
            built.role === DOCUMENT_TYPE_CLASSIFIER_ROLE,
        );
        if (
          createsDocumentTypeClassifier.length > 0 &&
          (createsDocumentTypeClassifier.length > 1 ||
            existingRows.some((row) =>
              isDocumentTypeClassifierProperty({
                content: row.content,
                name: row.name,
                role: row.role,
                tool: row.tool,
              }),
            ))
        ) {
          return {
            ok: false as const,
            status: 422 as const,
            message: "Document type classifier already exists",
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
          const dependencyRows = await tx
            .select({ id: properties.id })
            .from(properties)
            .where(
              and(
                eq(properties.workspaceId, workspaceId),
                inArray(properties.id, [...allDependencyIds]),
              ),
            );
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
          const { content, tool, dependencies, role } = built;
          const initialStatus = tool.type === "ai-model" ? "stale" : "fresh";

          // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- sequential property inserts in one transaction; each row's id feeds its dependency rows and audit event
          const [inserted] = await tx
            .insert(properties)
            .values({
              workspaceId,
              name,
              content,
              tool,
              role,
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
            // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- dependency rows reference the property id just inserted above in this iteration
            await tx.insert(propertyDependencies).values(
              dependencies.map(({ dependsOnPropertyId, condition }) => ({
                workspaceId,
                propertyId: inserted.id,
                dependsOnPropertyId,
                condition,
              })),
            );
          }

          // oxlint-disable-next-line no-await-in-loop -- ordered audit trail: one event per inserted property in this transaction
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

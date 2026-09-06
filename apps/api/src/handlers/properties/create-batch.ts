import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { properties, propertyDependencies } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  DOCUMENT_TYPE_CLASSIFIER_ROLE,
  buildPropertyParts,
  createPropertyBodySchema,
  isDocumentTypeClassifierProperty,
} from "@/api/lib/properties/create-schema";
import { propertyKindsForTool } from "@/api/lib/properties/property-kinds";
import { lockWorkspacePropertyWrites } from "@/api/lib/properties/property-lock";

const config = {
  description:
    "Add up to ten properties (columns) to a matter in a single transaction, " +
    "under the same rules as properties.create: all of them land or none do, " +
    "the resulting count must stay within the matter's property limit, every " +
    "dependency must be a property of this matter, and at most one " +
    "document-type classifier may exist. Returns the new property ids.",
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
      abortableTx(safeDb, async (tx) => {
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
          throw new HandlerError({
            status: 400,
            message: "Properties limit reached",
          });
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
          throw new HandlerError({
            status: 422,
            message: "Document type classifier already exists",
          });
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
            throw new HandlerError({
              status: 422,
              message: "Dependency property not found",
            });
          }
        }

        const propertyRows: (typeof properties.$inferInsert)[] = [];
        const dependencyRows: (typeof propertyDependencies.$inferInsert)[] = [];
        const insertedIds: SafeId<"property">[] = [];
        const auditEvents: AuditEvent[] = [];

        // Ids are minted here rather than read back from `returning`, so the
        // rows, their dependency rows and their audit events can be assembled
        // in full before anything is written: three statements for the batch
        // instead of two per item.
        for (const { name, built } of builtItems) {
          if ("status" in built) {
            continue;
          }
          const { content, tool, dependencies, role } = built;
          const propertyId = createSafeId<"property">();

          propertyRows.push({
            id: propertyId,
            workspaceId,
            name,
            content,
            tool,
            kinds: propertyKindsForTool(tool),
            role,
            status: tool.type === "ai-model" ? "stale" : "fresh",
          });

          for (const { dependsOnPropertyId, condition } of dependencies) {
            dependencyRows.push({
              workspaceId,
              propertyId,
              dependsOnPropertyId,
              condition,
            });
          }

          auditEvents.push({
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.PROPERTY,
            resourceId: propertyId,
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

          insertedIds.push(propertyId);
        }

        if (propertyRows.length > 0) {
          await tx.insert(properties).values(propertyRows);
        }
        if (dependencyRows.length > 0) {
          await tx.insert(propertyDependencies).values(dependencyRows);
        }

        // The recorder inserts an array in one statement, and one request is
        // one audit group.
        if (auditEvents.length > 0) {
          await recordAuditEvent(tx, auditEvents);
        }

        return { ids: insertedIds };
      }),
    );

    return Result.ok({ ids: txResult.ids });
  },
);

export default createPropertiesBatch;

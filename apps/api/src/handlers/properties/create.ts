import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { abortableTx } from "@/api/db/safe-db";
import { properties, propertyDependencies } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  buildPropertyParts,
  createPropertyBodySchema,
  isDocumentTypeClassifierProperty,
} from "@/api/lib/properties/create-schema";
import { propertyKindsForTool } from "@/api/lib/properties/property-kinds";
import { lockWorkspacePropertyWrites } from "@/api/lib/properties/property-lock";

const config = {
  description:
    "Add one property (a column) to a matter: its name, value type, and " +
    "either an AI prompt tool, optionally depending on other columns, or a " +
    "manual-input tool. An AI column is created stale, so its values are " +
    "produced by the next run rather than immediately. Refused when the " +
    "matter is at its property limit, when a dependency is not a property of " +
    "this matter, or when the matter already has a document-type classifier " +
    "column.",
  permissions: { property: ["create"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  body: createPropertyBodySchema,
} satisfies HandlerConfig;

const createProperty = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const built = buildPropertyParts(body);
    if ("status" in built) {
      return Result.err(
        new HandlerError({ status: built.status, message: built.message }),
      );
    }
    const { content, tool, dependencies, role } = built;

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

        if (existingRows.length >= LIMITS.propertiesCount) {
          throw new HandlerError({
            status: 400,
            message: "Properties limit reached",
          });
        }

        if (
          role !== null &&
          existingRows.some((row) =>
            isDocumentTypeClassifierProperty({
              content: row.content,
              name: row.name,
              role: row.role,
              tool: row.tool,
            }),
          )
        ) {
          throw new HandlerError({
            status: 422,
            message: "Document type classifier already exists",
          });
        }

        if (dependencies.length > 0) {
          const dependencyIds = [
            ...new Set(
              dependencies.map(
                ({ dependsOnPropertyId }) => dependsOnPropertyId,
              ),
            ),
          ];
          const dependencyRows = await tx.query.properties.findMany({
            where: {
              id: { in: dependencyIds },
              workspaceId: { eq: workspaceId },
            },
            columns: { id: true },
            limit: dependencyIds.length,
          });

          if (dependencyRows.length !== dependencyIds.length) {
            throw new HandlerError({
              status: 422,
              message: "Dependency property not found",
            });
          }
        }

        const initialStatus = tool.type === "ai-model" ? "stale" : "fresh";

        const [inserted] = await tx
          .insert(properties)
          .values({
            workspaceId,
            name: body.name,
            content,
            tool,
            kinds: propertyKindsForTool(tool),
            role,
            status: initialStatus,
          })
          .returning({ id: properties.id });

        if (!inserted) {
          throw new HandlerError({
            status: 500,
            message: "Failed to create property",
          });
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
                name: body.name,
                contentType: content.type,
                toolType: tool.type,
              },
            },
          },
        });

        return { id: inserted.id };
      }),
    );

    return Result.ok({ id: txResult.id });
  },
);

export default createProperty;

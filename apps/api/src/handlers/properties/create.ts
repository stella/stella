import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { properties, propertyDependencies } from "@/api/db/schema";
import {
  buildPropertyParts,
  createPropertyBodySchema,
} from "@/api/handlers/properties/create-schema";
import { lockWorkspacePropertyWrites } from "@/api/handlers/properties/property-lock";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: { property: ["create"] },
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
    const { content, tool, dependencies } = built;

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        await lockWorkspacePropertyWrites(tx, workspaceId);
        const existingRows = await tx
          .select({ id: properties.id })
          .from(properties)
          .where(eq(properties.workspaceId, workspaceId));

        if (existingRows.length >= LIMITS.propertiesCount) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Properties limit reached",
          };
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
          });

          if (dependencyRows.length !== dependencyIds.length) {
            return {
              ok: false as const,
              status: 422 as const,
              message: "Dependency property not found",
            };
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
                name: body.name,
                contentType: content.type,
                toolType: tool.type,
              },
            },
          },
        });

        return { ok: true as const, id: inserted.id };
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

    return Result.ok({ id: txResult.id });
  },
);

export default createProperty;

import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { properties } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";

const config = {
  permissions: { property: ["delete"] },
  params: workspaceParams({ propertyId: tSafeId("property") }),
} satisfies HandlerConfig;

const deleteProperty = createSafeHandler(
  config,
  // eslint-disable-next-line require-yield -- manual Result.isError checks preserve foreign-key error mapping
  async function* ({
    safeDb,
    session,
    workspaceId,
    user,
    request,
    params: { propertyId },
  }) {
    const deleteResult = await safeDb(async (tx) => {
      const propertyRows = await tx
        .select({
          id: properties.id,
          name: properties.name,
          content: properties.content,
          tool: properties.tool,
          system: properties.system,
        })
        .from(properties)
        .where(
          and(
            eq(properties.id, propertyId),
            eq(properties.workspaceId, workspaceId),
          ),
        )
        .for("update");
      const property = propertyRows.at(0);

      if (!property) {
        return {
          ok: false as const,
          status: 404 as const,
          message: "Property not found",
        };
      }

      if (property.system) {
        return {
          ok: false as const,
          status: 400 as const,
          message: "System properties cannot be deleted",
        };
      }

      // TODO: allow this in the future
      if (property.content.type === "file") {
        return {
          ok: false as const,
          status: 400 as const,
          message: "File properties cannot be deleted",
        };
      }

      await tx
        .delete(properties)
        .where(
          and(
            eq(properties.id, propertyId),
            eq(properties.workspaceId, workspaceId),
          ),
        );

      await writeAuditLog(
        {
          ...createAuditContext({
            organizationId: session.activeOrganizationId,
            workspaceId,
            userId: user.id,
            request,
          }),
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.PROPERTY,
          resourceId: propertyId,
          changes: {
            deleted: {
              old: {
                name: property.name,
                content: property.content,
                tool: property.tool,
              },
              new: null,
            },
          },
        },
        tx,
      );

      return { ok: true as const };
    });

    if (Result.isError(deleteResult)) {
      if (
        DatabaseError.is(deleteResult.error) &&
        deleteResult.error.code === PG_ERROR.FOREIGN_KEY_VIOLATION
      ) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Property is referenced by other properties",
          }),
        );
      }
      return Result.err(deleteResult.error);
    }

    if (!deleteResult.value.ok) {
      return Result.err(
        new HandlerError({
          status: deleteResult.value.status,
          message: deleteResult.value.message,
        }),
      );
    }

    return Result.ok(undefined);
  },
);

export default deleteProperty;

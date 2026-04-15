import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { properties } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

const config = {
  permissions: { property: ["delete"] },
  params: t.Object({
    propertyId: tNanoid,
  }),
} satisfies HandlerConfig;

const deleteProperty = createHandler(
  config,
  async ({ scopedDb, workspaceId, params: { propertyId } }) => {
    const property = await scopedDb((tx) =>
      tx.query.properties.findFirst({
        columns: { content: true, system: true },
        where: {
          id: propertyId,
          workspaceId: { eq: workspaceId },
        },
      }),
    );

    if (!property) {
      return status(404, { message: "Property not found" });
    }

    if (property.system) {
      return status(400, {
        message: "System properties cannot be deleted",
      });
    }

    // TODO: allow this in the future
    if (property.content.type === "file") {
      return status(400, {
        message: "File properties cannot be deleted",
      });
    }

    try {
      await scopedDb((tx) =>
        tx
          .delete(properties)
          .where(
            and(
              eq(properties.id, propertyId),
              eq(properties.workspaceId, workspaceId),
            ),
          ),
      );
    } catch (error) {
      if (isPgError(error, PG_ERROR.FOREIGN_KEY_VIOLATION)) {
        return status(400, {
          message: "Property is referenced by other properties",
        });
      }

      throw error;
    }

    return undefined;
  },
);

export default deleteProperty;

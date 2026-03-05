import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import { db } from "@/api/db";
import { properties } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

type DeletePropertyHandlerProps = {
  workspaceId: SafeId<"workspace">;
  propertyId: string;
};

export const deletePropertyHandler = async ({
  workspaceId,
  propertyId,
}: DeletePropertyHandlerProps) => {
  const property = await db.query.properties.findFirst({
    columns: { content: true, system: true },
    where: {
      id: propertyId,
      workspaceId: { eq: workspaceId },
    },
  });

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
    await db
      .delete(properties)
      .where(
        and(
          eq(properties.id, propertyId),
          eq(properties.workspaceId, workspaceId),
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

  return;
};

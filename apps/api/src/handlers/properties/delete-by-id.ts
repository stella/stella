import { eq } from "drizzle-orm";
import { status } from "elysia";

import { db } from "@/api/db";
import { properties } from "@/api/db/schema";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

type DeletePropertyHandlerProps = {
  propertyId: string;
};

export const deletePropertyHandler = async ({
  propertyId,
}: DeletePropertyHandlerProps) => {
  const property = await db.query.properties.findFirst({
    columns: { content: true, system: true },
    where: { id: propertyId },
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
    await db.delete(properties).where(eq(properties.id, propertyId));
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

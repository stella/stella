import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { properties } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";

const config = {
  permissions: { property: ["delete"] },
  params: workspaceParams({ propertyId: tSafeId("property") }),
} satisfies HandlerConfig;

const deleteProperty = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params: { propertyId } }) {
    const property = yield* Result.await(
      safeDb((tx) =>
        tx.query.properties.findFirst({
          columns: { content: true, system: true },
          where: {
            id: { eq: propertyId },
            workspaceId: { eq: workspaceId },
          },
        }),
      ),
    );

    if (!property) {
      return Result.err(
        new HandlerError({ status: 404, message: "Property not found" }),
      );
    }

    if (property.system) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "System properties cannot be deleted",
        }),
      );
    }

    // TODO: allow this in the future
    if (property.content.type === "file") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "File properties cannot be deleted",
        }),
      );
    }

    const deleteResult = await safeDb((tx) =>
      tx
        .delete(properties)
        .where(
          and(
            eq(properties.id, propertyId),
            eq(properties.workspaceId, workspaceId),
          ),
        ),
    );

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

    return Result.ok(undefined);
  },
);

export default deleteProperty;

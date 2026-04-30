import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { entities, fields } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getSearchProvider } from "@/api/lib/search/provider";

const config = {
  permissions: {
    entity: ["create", "update"],
  },
  body: t.Object({
    propertyId: tSafeId("property"),
    entityId: tSafeId("entity"),
    content: t.Union([
      t.Object({
        version: t.Literal(1),
        type: t.Literal("text"),
        value: t.String(),
      }),
      t.Object({
        version: t.Literal(1),
        type: t.Literal("single-select"),
        value: t.Nullable(t.String()),
      }),
      t.Object({
        version: t.Literal(1),
        type: t.Literal("multi-select"),
        value: t.Array(t.String({ minLength: 1 })),
      }),
      t.Object({
        version: t.Literal(1),
        type: t.Literal("date"),
        value: t.Nullable(t.String({ format: "date" })),
      }),
      t.Object({
        version: t.Literal(1),
        type: t.Literal("int"),
        value: t.Integer(),
        currency: t.Nullable(t.String({ minLength: 3, maxLength: 3 })),
      }),
    ]),
  }),
} satisfies HandlerConfig;

const upsertField = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body }) {
    const property = yield* Result.await(
      safeDb((tx) =>
        tx.query.properties.findFirst({
          columns: { id: true, content: true },
          where: {
            id: { eq: body.propertyId },
            workspaceId: { eq: workspaceId },
          },
        }),
      ),
    );

    if (!property) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Property not found in workspace",
        }),
      );
    }

    if (property.content.type !== body.content.type) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Property content type mismatch",
        }),
      );
    }

    const entity = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          columns: { id: true, currentVersionId: true, readOnly: true },
          where: {
            id: { eq: body.entityId },
            workspaceId: { eq: workspaceId },
          },
        }),
      ),
    );

    if (!entity) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Entity not found in workspace",
        }),
      );
    }
    if (entity.readOnly) {
      return Result.err(
        new HandlerError({ status: 409, message: "Entity is read-only" }),
      );
    }

    if (!entity.currentVersionId) {
      panic("Entity has no current version");
    }

    const entityVersionId = entity.currentVersionId;

    const isEmpty =
      body.content.value === null ||
      body.content.value === undefined ||
      body.content.value === "" ||
      (Array.isArray(body.content.value) && body.content.value.length === 0);

    const reindex = () => {
      getSearchProvider().indexEntity(body.entityId).catch(captureError);
    };

    if (isEmpty) {
      yield* Result.await(
        safeDb(async (tx) => {
          await tx
            .delete(fields)
            .where(
              and(
                eq(fields.propertyId, property.id),
                eq(fields.entityVersionId, entityVersionId),
              ),
            );
          await tx
            .update(entities)
            .set({ updatedAt: new Date() })
            .where(eq(entities.id, body.entityId));
        }),
      );
      reindex();
      return Result.ok(undefined);
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .delete(fields)
          .where(
            and(
              eq(fields.propertyId, property.id),
              eq(fields.entityVersionId, entityVersionId),
            ),
          );

        await tx.insert(fields).values({
          workspaceId,
          propertyId: property.id,
          entityVersionId,
          content: body.content,
        });

        await tx
          .update(entities)
          .set({ updatedAt: new Date() })
          .where(eq(entities.id, body.entityId));
      }),
    );
    reindex();
    return Result.ok(undefined);
  },
);

export default upsertField;

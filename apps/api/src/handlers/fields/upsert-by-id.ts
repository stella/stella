import { panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { entities, fields } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { getSearchProvider } from "@/api/lib/search/provider";

const config = {
  permissions: {
    entity: ["create", "update"],
  },
  body: t.Object({
    propertyId: tNanoid,
    entityId: tNanoid,
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

const upsertField = createHandler(
  config,
  async ({ scopedDb, workspaceId, body }) => {
    const property = await scopedDb((tx) =>
      tx.query.properties.findFirst({
        columns: { id: true, content: true },
        where: { id: body.propertyId, workspaceId: { eq: workspaceId } },
      }),
    );

    if (!property) {
      return status(404, {
        message: "Property not found in workspace",
      });
    }

    if (property.content.type !== body.content.type) {
      return status(400, {
        message: "Property content type mismatch",
      });
    }

    const entity = await scopedDb((tx) =>
      tx.query.entities.findFirst({
        columns: { id: true, currentVersionId: true },
        where: { id: body.entityId, workspaceId: { eq: workspaceId } },
      }),
    );

    if (!entity) {
      return status(404, {
        message: "Entity not found in workspace",
      });
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
      await scopedDb(async (tx) => {
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
      });
      reindex();
      return undefined;
    }

    await scopedDb(async (tx) => {
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
    });
    reindex();
    return undefined;
  },
);

export default upsertField;

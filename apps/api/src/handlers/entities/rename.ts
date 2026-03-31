import { panic } from "better-result";
import { eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { entities, fields } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { getSearchProvider } from "@/api/lib/search/provider";

export const renameEntityBodySchema = t.Object({
  entityId: tNanoid,
  name: t.String({
    minLength: 1,
    maxLength: LIMITS.entityNameMaxLength,
  }),
});

type RenameEntityBodySchema = Static<typeof renameEntityBodySchema>;

type RenameEntityHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  body: RenameEntityBodySchema;
};

export const renameEntityHandler = async ({
  scopedDb,
  workspaceId,
  body,
}: RenameEntityHandlerProps) => {
  const entity = await scopedDb((tx) =>
    tx.query.entities.findFirst({
      where: {
        id: body.entityId,
        workspaceId: { eq: workspaceId },
      },
      columns: { id: true },
    }),
  );

  if (!entity) {
    return status(404, { message: "Entity not found" });
  }

  await scopedDb(async (tx) => {
    await tx
      .update(entities)
      .set({ name: body.name, updatedAt: new Date() })
      .where(eq(entities.id, body.entityId));

    // Also update the file field's fileName so the table
    // column (which reads content.fileName) stays in sync.
    const fileField = await tx.query.entities
      .findFirst({
        where: { id: body.entityId },
        columns: { id: true },
        with: {
          currentVersion: {
            columns: { id: true },
            with: {
              fields: {
                columns: { id: true, content: true },
              },
            },
          },
        },
      })
      .then((e) => {
        const cv = e?.currentVersion ?? panic("Entity has no currentVersion");
        return cv.fields.find((f) => f.content.type === "file");
      });

    if (fileField && fileField.content.type === "file") {
      await tx
        .update(fields)
        .set({
          content: {
            ...fileField.content,
            fileName: body.name,
          },
        })
        .where(eq(fields.id, fileField.id));
    }
  });

  getSearchProvider().indexEntity(body.entityId).catch(captureError);

  return { entityId: body.entityId };
};

const config = {
  permissions: { entity: ["update"] },
  body: renameEntityBodySchema,
} satisfies HandlerConfig;

const renameEntity = createHandler(
  config,
  async ({ scopedDb, workspaceId, body }) =>
    await renameEntityHandler({
      scopedDb,
      workspaceId,
      body,
    }),
);

export default renameEntity;

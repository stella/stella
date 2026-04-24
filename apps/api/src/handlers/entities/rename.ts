import { Result, panic } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import { entities, fields } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tUuid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { getSearchProvider } from "@/api/lib/search/provider";

const renameEntityBodySchema = t.Object({
  entityId: tUuid,
  name: t.String({
    minLength: 1,
    maxLength: LIMITS.entityNameMaxLength,
  }),
});

type RenameEntityBodySchema = Static<typeof renameEntityBodySchema>;

type RenameEntityHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  body: RenameEntityBodySchema;
};

const renameEntityHandler = async function* ({
  safeDb,
  workspaceId,
  body,
}: RenameEntityHandlerProps) {
  const entity = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findFirst({
        where: {
          id: body.entityId,
          workspaceId: { eq: workspaceId },
        },
        columns: { id: true },
      }),
    ),
  );

  if (!entity) {
    return Result.err(
      new HandlerError({ status: 404, message: "Entity not found" }),
    );
  }

  yield* Result.await(
    safeDb(async (tx) => {
      await tx
        .update(entities)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(entities.id, body.entityId));

      // Also update the file field's fileName so the table
      // column (which reads content.fileName) stays in sync.
      // Only file fields need sanitization (zip-slip prevention);
      // the entity display name is kept as the user typed it.
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
              fileName: sanitizeFilename(body.name),
            },
          })
          .where(eq(fields.id, fileField.id));
      }
    }),
  );

  getSearchProvider().indexEntity(body.entityId).catch(captureError);

  return Result.ok({ entityId: body.entityId });
};

const config = {
  permissions: { entity: ["update"] },
  body: renameEntityBodySchema,
} satisfies HandlerConfig;

const renameEntity = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body }) {
    return yield* renameEntityHandler({
      safeDb,
      workspaceId,
      body,
    });
  },
);

export default renameEntity;

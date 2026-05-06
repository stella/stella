import { Result, panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { cellMetadata } from "@/api/db/schema";
import type { CellMetadata } from "@/api/db/schema-validators";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: {
    entity: ["update"],
  },
  body: t.Object({
    propertyId: tSafeId("property"),
    entityId: tSafeId("entity"),
    manualFlags: t.Array(t.String({ minLength: 1, maxLength: 64 }), {
      maxItems: 16,
    }),
  }),
} satisfies HandlerConfig;

const updateCellMetadata = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, user }) {
    const entity = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          columns: { id: true, currentVersionId: true },
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

    const property = yield* Result.await(
      safeDb((tx) =>
        tx.query.properties.findFirst({
          columns: { id: true },
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

    if (!entity.currentVersionId) {
      panic("Entity has no current version");
    }

    const manualFlags = [...new Set(body.manualFlags)].toSorted();
    const entityVersionId = entity.currentVersionId;
    const existingMetadata = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ metadata: cellMetadata.metadata })
          .from(cellMetadata)
          .where(
            and(
              eq(cellMetadata.entityVersionId, entityVersionId),
              eq(cellMetadata.propertyId, property.id),
            ),
          )
          .limit(1),
      ),
    );

    if (manualFlags.length === 0) {
      yield* Result.await(
        safeDb((tx) =>
          tx
            .delete(cellMetadata)
            .where(
              and(
                eq(cellMetadata.entityVersionId, entityVersionId),
                eq(cellMetadata.propertyId, property.id),
              ),
            ),
        ),
      );
      return Result.ok({ success: true });
    }

    const existingProvenance =
      existingMetadata.at(0)?.metadata.flagProvenance ?? {};
    const addedAt = new Date().toISOString();
    const metadata: CellMetadata = {
      version: 1,
      manualFlags,
      flagProvenance: Object.fromEntries(
        manualFlags.map((flag) => [
          flag,
          existingProvenance[flag] ?? {
            addedBy: user.id,
            addedAt,
          },
        ]),
      ),
    };

    yield* Result.await(
      safeDb((tx) =>
        tx
          .insert(cellMetadata)
          .values({
            workspaceId,
            entityVersionId,
            propertyId: property.id,
            metadata,
            createdBy: user.id,
            updatedBy: user.id,
          })
          .onConflictDoUpdate({
            target: [cellMetadata.entityVersionId, cellMetadata.propertyId],
            set: {
              metadata,
              updatedBy: user.id,
              updatedAt: new Date(),
            },
          }),
      ),
    );

    return Result.ok({ success: true });
  },
);

export default updateCellMetadata;

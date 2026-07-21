import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const readEntityByIdParamsSchema = workspaceParams({
  entityId: tSafeId("entity", { description: "Document entity ID" }),
});

type ReadEntityByIdHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
};

export const readEntityByIdHandler = async function* ({
  safeDb,
  workspaceId,
  entityId,
}: ReadEntityByIdHandlerProps) {
  // Read the entity, its current version, and that version's fields in ONE
  // query via the `currentVersion` relation. Reading currentVersionId here and
  // its fields in a separate query keyed by that value left a TOCTOU window: a
  // concurrent version delete promotes currentVersionId to the next live
  // version and tombstones the old one, so a fields read keyed by the
  // now-stale value could surface the withdrawn version's content. The relation
  // read is atomic, and currentVersionId is an invariant-live version (delete
  // promotes it off any withdrawn row), so this can only ever return live
  // content.
  const entity = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findFirst({
        where: {
          id: { eq: entityId },
          workspaceId: {
            eq: workspaceId,
          },
        },
        columns: {
          kind: true,
          name: true,
        },
        with: {
          currentVersion: {
            columns: { id: true },
            with: {
              // Fields of one entity version: at most one row per property
              // (fields_property_id_entity_version_id_key), so this is
              // structurally bounded by properties-per-workspace; `limit`
              // pins that same bound explicitly for the lint rule below.
              // `id` is a Bun.randomUUIDv7() primary key (time-ordered), so
              // ordering by it gives a stable field-creation order. This
              // MUST match the ordering `processExtraction` applies to the
              // same relation -- both feed `findExtractionFileField`'s
              // "first file field" selection, which must resolve to the
              // SAME field wherever it runs (see findExtractionFileField).
              fields: {
                columns: { id: true, propertyId: true, content: true },
                orderBy: { id: "asc" },
                limit: LIMITS.propertiesCount,
              },
            },
          },
        },
      }),
    ),
  );

  if (!entity) {
    return Result.err(
      new HandlerError({ status: 404, message: "Entity not found" }),
    );
  }

  if (!entity.currentVersion) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Entity has no current version",
      }),
    );
  }

  return Result.ok({
    entityId,
    kind: entity.kind,
    name: entity.name,
    fields: entity.currentVersion.fields,
  });
};

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "tool", name: "read_document" },
  params: readEntityByIdParamsSchema,
} satisfies HandlerConfig;

const readEntityById = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params }) {
    return yield* readEntityByIdHandler({
      safeDb,
      workspaceId,
      entityId: params.entityId,
    });
  },
);

export default readEntityById;

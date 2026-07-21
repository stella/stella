import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const readVersionByIdParamsSchema = workspaceParams({
  entityId: tSafeId("entity"),
  versionId: tSafeId("entityVersion"),
});

type ReadVersionByIdHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  versionId: SafeId<"entityVersion">;
};

const readVersionByIdHandler = async function* ({
  safeDb,
  workspaceId,
  entityId,
  versionId,
}: ReadVersionByIdHandlerProps) {
  // Validate entity exists in workspace
  const entity = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findFirst({
        where: {
          id: { eq: entityId },
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

  // Fetch the version metadata AND its fields in a single tombstone-checked
  // query. Reading the fields separately (keyed only by entityVersionId) after
  // a `deletedAt IS NULL` metadata check left a TOCTOU window: a tombstone
  // landing between the two reads would still return the withdrawn version's
  // field content. Tying the fields to the same live-version row closes it —
  // either the live version and its fields come back together, or neither does.
  const versionRow = yield* Result.await(
    safeDb((tx) =>
      tx.query.entityVersions.findFirst({
        where: {
          id: { eq: versionId },
          entityId: { eq: entityId },
          workspaceId: { eq: workspaceId },
          deletedAt: { isNull: true },
        },
        columns: {
          id: true,
          versionNumber: true,
          stamp: true,
          createdAt: true,
        },
        with: {
          // SAFETY: fields of one entity version, bounded by
          // properties-per-workspace (LIMITS.propertiesCount).
          fields: {
            columns: {
              id: true,
              propertyId: true,
              content: true,
            },
          },
        },
      }),
    ),
  );

  if (!versionRow) {
    return Result.err(
      new HandlerError({ status: 404, message: "Version not found" }),
    );
  }

  return Result.ok({
    id: versionRow.id,
    versionNumber: versionRow.versionNumber,
    stamp: versionRow.stamp,
    createdAt: versionRow.createdAt.toISOString(),
    fields: versionRow.fields,
  });
};

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "read_document" },
  access: "read",
  params: readVersionByIdParamsSchema,
} satisfies HandlerConfig;

const readVersionById = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params }) {
    return yield* readVersionByIdHandler({
      safeDb,
      workspaceId,
      entityId: params.entityId,
      versionId: params.versionId,
    });
  },
);

export default readVersionById;

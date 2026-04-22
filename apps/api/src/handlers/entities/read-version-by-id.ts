import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { entityVersions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const readVersionByIdParamsSchema = workspaceParams({
  entityId: t.String(),
  versionId: t.String(),
});

type ReadVersionByIdHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: string;
  versionId: string;
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
          id: entityId,
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

  // Fetch the specific version
  const version = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          id: entityVersions.id,
          versionNumber: entityVersions.versionNumber,
          stamp: entityVersions.stamp,
          createdAt: entityVersions.createdAt,
        })
        .from(entityVersions)
        .where(
          and(
            eq(entityVersions.id, versionId),
            eq(entityVersions.entityId, entityId),
            eq(entityVersions.workspaceId, workspaceId),
          ),
        )
        .limit(1),
    ),
  );

  const versionRow = version.at(0);
  if (!versionRow) {
    return Result.err(
      new HandlerError({ status: 404, message: "Version not found" }),
    );
  }

  // Fetch fields for this version
  const versionFields = yield* Result.await(
    safeDb((tx) =>
      tx.query.fields.findMany({
        where: { entityVersionId: versionId },
        columns: {
          id: true,
          propertyId: true,
          content: true,
        },
      }),
    ),
  );

  return Result.ok({
    id: versionRow.id,
    versionNumber: versionRow.versionNumber,
    stamp: versionRow.stamp,
    createdAt: versionRow.createdAt.toISOString(),
    fields: versionFields,
  });
};

const config = {
  permissions: { workspace: ["read"] },
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

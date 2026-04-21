import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const readEntityByIdParamsSchema = workspaceParams({ entityId: t.String() });

type ReadEntityByIdHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: string;
};

export const readEntityByIdHandler = async function* ({
  safeDb,
  workspaceId,
  entityId,
}: ReadEntityByIdHandlerProps) {
  const entity = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findFirst({
        where: {
          id: entityId,
          workspaceId: {
            eq: workspaceId,
          },
        },
        columns: {
          currentVersionId: true,
          kind: true,
          name: true,
        },
      }),
    ),
  );

  if (!entity) {
    return Result.err(
      new HandlerError({ status: 404, message: "Entity not found" }),
    );
  }

  if (!entity.currentVersionId) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Entity has no current version",
      }),
    );
  }

  const currentVersionId = entity.currentVersionId;

  const fields = yield* Result.await(
    safeDb((tx) =>
      tx.query.fields.findMany({
        where: {
          entityVersionId: currentVersionId,
        },
        columns: {
          id: true,
          propertyId: true,
          content: true,
        },
      }),
    ),
  );

  return Result.ok({
    entityId,
    kind: entity.kind,
    name: entity.name,
    fields,
  });
};

const config = {
  permissions: { workspace: ["read"] },
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

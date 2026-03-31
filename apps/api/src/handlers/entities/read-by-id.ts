import { status, t } from "elysia";

import type { ScopedDb } from "@/api/db";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";

export const readEntityByIdParamsSchema = t.Object({
  entityId: t.String(),
});

type ReadEntityByIdHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  entityId: string;
};

export const readEntityByIdHandler = async ({
  scopedDb,
  workspaceId,
  entityId,
}: ReadEntityByIdHandlerProps) => {
  const entity = await scopedDb((tx) =>
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
  );

  if (!entity) {
    return status(404);
  }

  if (!entity.currentVersionId) {
    return status(400, { message: "Entity has no current version" });
  }

  const currentVersionId = entity.currentVersionId;

  const fields = await scopedDb((tx) =>
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
  );

  return {
    entityId,
    kind: entity.kind,
    name: entity.name,
    fields,
  };
};

const config = {
  permissions: { workspace: ["read"] },
  params: readEntityByIdParamsSchema,
} satisfies HandlerConfig;

const readEntityById = createHandler(
  config,
  async ({ scopedDb, workspaceId, params }) =>
    await readEntityByIdHandler({
      scopedDb,
      workspaceId,
      entityId: params.entityId,
    }),
);

export default readEntityById;

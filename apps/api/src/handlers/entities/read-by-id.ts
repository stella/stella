import { status } from "elysia";

import { db } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";

type ReadEntityByIdHandlerProps = {
  workspaceId: SafeId<"workspace">;
  entityId: string;
};

export const readEntityByIdHandler = async ({
  workspaceId,
  entityId,
}: ReadEntityByIdHandlerProps) => {
  const entity = await db.query.entities.findFirst({
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
  });

  if (!entity) {
    return status(404);
  }

  if (!entity.currentVersionId) {
    return status(400, { message: "Entity has no current version" });
  }

  const fields = await db.query.fields.findMany({
    where: {
      entityVersionId: entity.currentVersionId,
    },
    columns: {
      id: true,
      propertyId: true,
      content: true,
    },
  });

  return {
    entityId,
    name: entity.name,
    fields,
  };
};

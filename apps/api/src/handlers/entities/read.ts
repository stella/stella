import { panic } from "better-result";

import { db } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

type ReadEntitiesHandlerProps = {
  workspaceId: SafeId<"workspace">;
};

export const readEntitiesHandler = async ({
  workspaceId,
}: ReadEntitiesHandlerProps) => {
  const entityRows = await db.query.entities.findMany({
    where: { workspaceId: { eq: workspaceId } },
    orderBy: { createdAt: "asc" },
    limit: LIMITS.entitiesCount,
    columns: {
      id: true,
      kind: true,
      name: true,
      parentId: true,
      createdAt: true,
      updatedAt: true,
    },
    with: {
      createdByUser: {
        columns: { name: true, image: true },
      },
      versions: {
        columns: { id: true },
      },
      currentVersion: {
        columns: { id: true },
        with: {
          fields: {
            columns: {
              id: true,
              propertyId: true,
              content: true,
            },
          },
        },
      },
    },
  });

  return entityRows.map((entity) => {
    if (!entity.currentVersion) {
      panic("Entity has no currentVersion");
    }

    return {
      entityId: entity.id,
      kind: entity.kind,
      name: entity.name,
      parentId: entity.parentId,
      createdAt: entity.createdAt.toISOString(),
      createdBy: entity.createdByUser?.name ?? null,
      createdByImage: entity.createdByUser?.image ?? null,
      version: entity.versions.length,
      updatedAt: entity.updatedAt?.toISOString() ?? null,
      fields: entity.currentVersion.fields.map((field) => ({
        id: field.id,
        propertyId: field.propertyId,
        entityId: entity.id,
        content: field.content,
      })),
    };
  });
};

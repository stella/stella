import type { EntityKind } from "@/lib/types";

export type CopyToMatterEntity = {
  entityId: string;
  entityName: string;
  kind: EntityKind;
  parentId: string | null;
  children: CopyToMatterEntity[];
};

export const getCopyToMatterRootEntities = (
  entities: readonly CopyToMatterEntity[],
): CopyToMatterEntity[] => {
  const selectedIds = new Set(entities.map((entity) => entity.entityId));
  const entitiesById = new Map(
    entities.map((entity) => [entity.entityId, entity]),
  );
  const descendantIds = new Set<string>();

  const collectSelectedDescendants = (entity: CopyToMatterEntity) => {
    for (const child of entity.children) {
      if (selectedIds.has(child.entityId)) {
        descendantIds.add(child.entityId);
      }
      collectSelectedDescendants(child);
    }
  };

  for (const entity of entities) {
    if (entity.kind === "folder") {
      collectSelectedDescendants(entity);
    }
  }

  return entities.filter(
    (entity) =>
      !descendantIds.has(entity.entityId) &&
      !hasSelectedAncestor({ entity, entitiesById, selectedIds }),
  );
};

type HasSelectedAncestorOptions = {
  entity: CopyToMatterEntity;
  entitiesById: ReadonlyMap<string, CopyToMatterEntity>;
  selectedIds: ReadonlySet<string>;
};

const hasSelectedAncestor = ({
  entity,
  entitiesById,
  selectedIds,
}: HasSelectedAncestorOptions): boolean => {
  const visitedIds = new Set([entity.entityId]);
  let parentId = entity.parentId;

  while (parentId) {
    if (visitedIds.has(parentId)) {
      return false;
    }
    if (selectedIds.has(parentId)) {
      return true;
    }

    visitedIds.add(parentId);
    const parent = entitiesById.get(parentId);
    if (!parent) {
      return false;
    }
    parentId = parent.parentId;
  }

  return false;
};

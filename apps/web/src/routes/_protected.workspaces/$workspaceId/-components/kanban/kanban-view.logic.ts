import type { WorkspaceEntity, WorkspaceProperty } from "@/lib/types";
import { resolveKanbanGroupBy } from "@/routes/_protected.workspaces/$workspaceId/-utils";

const STATUS_GROUP_ID = "_status";
const KIND_GROUP_ID = "_kind";
const CREATED_BY_GROUP_ID = "_created-by";

type BuiltInKanbanPropertyId =
  | typeof KIND_GROUP_ID
  | typeof CREATED_BY_GROUP_ID;

export type KanbanGrouping =
  | { type: "none" }
  | { type: "status"; propertyId: typeof STATUS_GROUP_ID }
  | { type: "built-in"; propertyId: BuiltInKanbanPropertyId }
  | {
      type: "property";
      propertyId: string;
      property: WorkspaceProperty;
    };

const isBuiltInKanbanPropertyId = (
  propertyId: string,
): propertyId is BuiltInKanbanPropertyId =>
  propertyId === KIND_GROUP_ID || propertyId === CREATED_BY_GROUP_ID;

const unreachableGrouping = (grouping: never): never => {
  throw new Error(`Unhandled kanban grouping: ${JSON.stringify(grouping)}`);
};

export const resolveKanbanGrouping = (
  configuredGroupBy: string,
  properties: readonly WorkspaceProperty[],
): KanbanGrouping => {
  const propertyId = resolveKanbanGroupBy(configuredGroupBy, properties);

  if (propertyId === "") {
    return { type: "none" };
  }

  if (propertyId === STATUS_GROUP_ID) {
    return { type: "status", propertyId };
  }

  if (isBuiltInKanbanPropertyId(propertyId)) {
    return { type: "built-in", propertyId };
  }

  const property = properties.find((p) => p.id === propertyId);
  if (!property) {
    return { type: "none" };
  }

  return {
    type: "property",
    propertyId,
    property,
  };
};

export const getKanbanGroupingPropertyId = (
  grouping: KanbanGrouping,
): string | null => {
  switch (grouping.type) {
    case "none":
      return null;
    case "status":
    case "built-in":
    case "property":
      return grouping.propertyId;
    default:
      return unreachableGrouping(grouping);
  }
};

export const selectKanbanEntitiesForGrouping = (
  entities: readonly WorkspaceEntity[],
  grouping: KanbanGrouping,
): WorkspaceEntity[] => {
  switch (grouping.type) {
    case "none":
      return [];
    case "status":
      return entities.filter((entity) => entity.kind === "task");
    case "built-in":
    case "property":
      return [...entities];
    default:
      return unreachableGrouping(grouping);
  }
};

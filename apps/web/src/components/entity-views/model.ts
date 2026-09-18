import { panic } from "better-result";

import {
  ENTITY_VIEW_GROUP,
  type ENTITY_VIEW_COLUMNS,
} from "@stll/api-contract/entity-views";

import { getEntityName } from "@/components/workspaces/entity-utils";

import type { EntityViewEntry, EntityViewRow } from "./types";

export { ENTITY_VIEW_GROUP };

export const entryId = (entry: EntityViewEntry) =>
  entry.type === "entity"
    ? `entity:${entry.entity.entityId}`
    : `proposal:${entry.signal.id}`;

export const entryMatterId = (entry: EntityViewEntry) =>
  entry.type === "entity" ? entry.workspaceId : entry.signal.workspaceId;

const entryKind = (entry: EntityViewEntry) =>
  entry.type === "entity" ? entry.entity.kind : entry.projection.kind;

export const entryStatus = (entry: EntityViewEntry) =>
  entry.type === "entity" ? entry.entity.status : entry.projection.status;

export const entryType = (entry: EntityViewEntry) => {
  if (entry.type === "entity") {
    return entry.entity.agendaKind === "deadline"
      ? "deadline"
      : entry.entity.kind;
  }
  return entry.projection.type;
};

export const entryDueDate = (entry: EntityViewEntry) =>
  entry.type === "entity" ? entry.entity.dueDate : entry.projection.dueDate;

export const toEntityViewRow = (entry: EntityViewEntry): EntityViewRow => ({
  kind: "entity-view",
  entry,
  children: [],
});

export const entryGroupValue = (
  entry: EntityViewEntry,
  id: string,
): string | null => {
  switch (id) {
    case ENTITY_VIEW_GROUP.STATUS:
      return entryStatus(entry);
    case ENTITY_VIEW_GROUP.KIND:
      return entryKind(entry);
    case ENTITY_VIEW_GROUP.TYPE:
      return entryType(entry);
    case ENTITY_VIEW_GROUP.MATTER:
      return entryMatterId(entry);
    case ENTITY_VIEW_GROUP.AUTHOR:
      return entry.type === "entity"
        ? entry.entity.createdByUserId
        : entry.signal.createdByUserId;
    case "":
      return null;
    default:
      return panic(`Unsupported collection grouping: ${id}`);
  }
};

type SortableColumn = {
  [
    Key in keyof typeof ENTITY_VIEW_COLUMNS
  ]: (typeof ENTITY_VIEW_COLUMNS)[Key]["sortable"] extends true ? Key : never;
}[keyof typeof ENTITY_VIEW_COLUMNS];

export const entityViewSortValues = {
  _name: (entry: EntityViewEntry) =>
    entry.type === "entity" ? getEntityName(entry.entity) : entry.signal.title,
  _status: entryStatus,
  _priority: (entry: EntityViewEntry) =>
    entry.type === "entity" ? entry.entity.priority : null,
  "_due-date": entryDueDate,
} satisfies Record<SortableColumn, (entry: EntityViewEntry) => string | null>;

export const isEntityViewSortColumn = (
  value: string,
): value is SortableColumn => Object.hasOwn(entityViewSortValues, value);

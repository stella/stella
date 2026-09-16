import { panic } from "better-result";

import { ENTITY_VIEW_COLUMNS } from "@stll/api-contract/entity-views";
import { SUGGESTION_KIND } from "@stll/api-contract/signals";
import { compareByLocale } from "@stll/collation";
import {
  evaluateCondition,
  foldCondition,
  isEffectiveLeaf,
  pruneIncomplete,
} from "@stll/conditions";
import type { ConditionNode } from "@stll/conditions";

import { getEntityName } from "@/components/workspaces/entity-utils";
import type { ViewLayout } from "@/lib/types";

import type { EntityViewEntry, EntityViewRow } from "./types";

export { ENTITY_VIEW_GROUP } from "@stll/api-contract/entity-views";
import { ENTITY_VIEW_GROUP } from "@stll/api-contract/entity-views";

export const entrySuggestion = (entry: EntityViewEntry) =>
  entry.type === "proposal"
    ? entry.signal.suggestions.find(
        (suggestion) =>
          suggestion.kind === SUGGESTION_KIND.CREATE_TASK ||
          suggestion.kind === SUGGESTION_KIND.CREATE_DEADLINE,
      )
    : undefined;

export const entryId = (entry: EntityViewEntry) =>
  entry.type === "entity"
    ? `entity:${entry.entity.entityId}`
    : `proposal:${entry.signal.id}`;

export const entryMatterId = (entry: EntityViewEntry) =>
  entry.type === "entity" ? entry.workspaceId : entry.signal.workspaceId;

export const entryKind = (entry: EntityViewEntry) =>
  entry.type === "entity"
    ? entry.entity.kind
    : entrySuggestion(entry)
      ? "task"
      : null;

export const entryStatus = (entry: EntityViewEntry) =>
  entry.type === "entity"
    ? entry.entity.status
    : entrySuggestion(entry)
      ? "open"
      : null;

export const entryType = (entry: EntityViewEntry) => {
  if (entry.type === "entity") {
    return entry.entity.agendaKind === "deadline"
      ? "deadline"
      : entry.entity.kind;
  }
  const suggestion = entrySuggestion(entry);
  return suggestion?.kind === SUGGESTION_KIND.CREATE_DEADLINE
    ? "deadline"
    : suggestion
      ? "task"
      : null;
};

export const proposalMatchesFilters = (
  entry: Extract<EntityViewEntry, { type: "proposal" }>,
  filters: readonly ConditionNode[],
) =>
  filters.every((filter) => {
    const pruned = pruneIncomplete(filter);
    if (!pruned) return true;
    const effective = foldCondition(pruned, {
      leaf: (node): ConditionNode | null =>
        isEffectiveLeaf(node) ? node : null,
      group: (node, children) => ({ ...node, children: [...children] }),
    });
    if (!effective) return true;
    return evaluateCondition(effective, (operand) => {
      switch (operand.type) {
        case "kind":
          return entryKind(entry);
        case "builtin": {
          const values = {
            status: entryStatus(entry),
            priority: "none",
            agendaKind: entryType(entry),
          } satisfies Record<typeof operand.field, string | null>;
          return values[operand.field];
        }
        case "property":
          // A proposal has no extracted/custom property values before acceptance.
          return null;
        case "path":
        case "formula":
          return panic("Unsupported view-filter operand");
        default:
          operand satisfies never;
          return panic("Unknown view-filter operand");
      }
    });
  });

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
  "_due-date": (entry: EntityViewEntry) =>
    entry.type === "entity"
      ? entry.entity.dueDate
      : (entrySuggestion(entry)?.dueAt ?? null),
} satisfies Record<SortableColumn, (entry: EntityViewEntry) => string | null>;

export const isEntityViewSortColumn = (
  value: string,
): value is SortableColumn => Object.hasOwn(entityViewSortValues, value);

type SortEntityViewEntriesOptions = {
  entries: readonly EntityViewEntry[];
  sorts: ViewLayout["sorts"];
  locale: string;
};

/** Sort the loaded window, including proposals, with absent values last. */
export const sortEntityViewEntries = ({
  entries,
  sorts,
  locale,
}: SortEntityViewEntriesOptions) => {
  const compare = compareByLocale(locale);
  const accessors = sorts.map(({ propertyId, desc }) => {
    if (!isEntityViewSortColumn(propertyId))
      panic(`Unsupported collection sort: ${propertyId}`);
    return { getValue: entityViewSortValues[propertyId], desc };
  });
  return entries.toSorted((left, right) => {
    for (const { getValue, desc } of accessors) {
      const a = getValue(left);
      const b = getValue(right);
      if (a === b) continue;
      if (a === null) return 1;
      if (b === null) return -1;
      const order = compare(a, b);
      if (order !== 0) return desc ? -order : order;
    }
    return 0;
  });
};

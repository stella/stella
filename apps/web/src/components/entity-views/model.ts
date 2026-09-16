import { panic } from "better-result";

import { SUGGESTION_KIND } from "@stll/api-contract/signals";
import {
  evaluateCondition,
  foldCondition,
  isEffectiveLeaf,
  pruneIncomplete,
} from "@stll/conditions";
import type { ConditionNode } from "@stll/conditions";

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
  entry.type === "entity" ? entry.entity.kind : entrySuggestion(entry) ? "task" : null;

export const entryStatus = (entry: EntityViewEntry) =>
  entry.type === "entity" ? entry.entity.status : entrySuggestion(entry) ? "open" : null;

export const entryType = (entry: EntityViewEntry) => {
  if (entry.type === "entity") {
    return entry.entity.agendaKind === "deadline" ? "deadline" : entry.entity.kind;
  }
  const suggestion = entrySuggestion(entry);
  return suggestion?.kind === SUGGESTION_KIND.CREATE_DEADLINE
    ? "deadline"
    : suggestion ? "task" : null;
};

export const proposalMatchesFilters = (
  entry: Extract<EntityViewEntry, { type: "proposal" }>,
  filters: readonly ConditionNode[],
) =>
  filters.every((filter) => {
    const pruned = pruneIncomplete(filter);
    if (!pruned) return true;
    const effective = foldCondition(pruned, {
      leaf: (node): ConditionNode | null => isEffectiveLeaf(node) ? node : null,
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

export const entryGroupValue = (entry: EntityViewEntry, id: string): string | null => {
    switch (id) {
      case ENTITY_VIEW_GROUP.STATUS: return entryStatus(entry);
      case ENTITY_VIEW_GROUP.KIND: return entryKind(entry);
      case ENTITY_VIEW_GROUP.TYPE: return entryType(entry);
      case ENTITY_VIEW_GROUP.MATTER: return entryMatterId(entry);
      case ENTITY_VIEW_GROUP.AUTHOR: return entry.type === "entity" ? entry.entity.createdByUserId : entry.signal.createdByUserId;
      case "": return null;
      default: return panic(`Unsupported collection grouping: ${id}`);
    }
};

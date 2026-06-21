import { createContext, useContext } from "react";

// Identifies the grouped-view subtable a column header lives in. The shared
// column definitions are reused across every group, so a header learns its
// group from this context (provided per section) rather than from its column
// def. `null` outside a grouped view (the flat table), where actions fall back
// to the whole-view scope.
export type GroupScope = {
  groupByPropertyId: string;
  groupValue: string | null;
  // The grouping property's option values, so a "mark this group as reviewed" on
  // the uncategorized subtable targets the same stale/empty cells it shows.
  optionValues: string[] | undefined;
  label: string;
};

const GroupScopeContext = createContext<GroupScope | null>(null);

export const GroupScopeProvider = GroupScopeContext.Provider;

export const useGroupScope = (): GroupScope | null =>
  useContext(GroupScopeContext);

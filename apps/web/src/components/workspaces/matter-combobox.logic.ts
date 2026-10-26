import { createSearchQueryMatcher } from "@stll/text-normalize";

type SearchableMatterOption = {
  clientName: string | null;
  name: string;
};

/**
 * A matter matches on its name or its client's, accent- and
 * case-insensitively, so "novak" finds "Novák v. Horák".
 */
export const matchesMatterOption = (
  { clientName, name }: SearchableMatterOption,
  query: string,
): boolean => {
  const matches = createSearchQueryMatcher(query);
  return matches(name) || matches(clientName);
};

/** How many matters the picker's "recent" group offers. */
export const MATTER_PICKER_RECENT_LIMIT = 5;

export const MATTER_OPTION_GROUP = {
  recent: "recent",
  all: "all",
} as const;

export type MatterOptionGroupKey =
  (typeof MATTER_OPTION_GROUP)[keyof typeof MATTER_OPTION_GROUP];

/** A Base UI combobox group: its key and the options it holds. */
export type MatterOptionGroup<TMatter> = {
  items: TMatter[];
  value: MatterOptionGroupKey;
};

/**
 * Whether the picker is browsing (show groups) rather than searching (show
 * one filtered list). The input still showing the chosen matter's name counts
 * as browsing, since nothing has been typed.
 */
export const isBrowsingMatters = ({
  query,
  selectedName,
}: {
  query: string;
  selectedName: string | null;
}): boolean => query.trim().length === 0 || query === selectedName;

/**
 * The recent matters, in their ranked order, then every other matter in the
 * list's own order. Each matter appears once; an empty group is left out.
 */
export const groupMatterOptions = <TMatter extends { id: string }>({
  matters,
  recentIds,
}: {
  matters: readonly TMatter[];
  recentIds: readonly string[];
}): MatterOptionGroup<TMatter>[] => {
  const byId = new Map(matters.map((matter) => [matter.id, matter]));
  const recent = recentIds.flatMap((id) => {
    const matter = byId.get(id);
    return matter === undefined ? [] : [matter];
  });
  const recentSet = new Set(recent.map((matter) => matter.id));
  const groups: MatterOptionGroup<TMatter>[] = [
    { value: MATTER_OPTION_GROUP.recent, items: recent },
    {
      value: MATTER_OPTION_GROUP.all,
      items: matters.filter((matter) => !recentSet.has(matter.id)),
    },
  ];
  return groups.filter((group) => group.items.length > 0);
};

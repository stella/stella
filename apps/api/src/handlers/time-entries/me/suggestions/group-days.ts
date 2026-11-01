import type { SafeId } from "@/api/lib/branded-types";

export type SuggestionMatterLabel = {
  id: SafeId<"workspace">;
  name: string;
  reference: string;
};

type DayScope = { date: string; workspaceId: SafeId<"workspace"> };

export type SuggestionDay<Item extends { durationMinutes: number }> = {
  date: string;
  matters: {
    matter: SuggestionMatterLabel;
    activeMinutes: number;
    items: Item[];
  }[];
};

/**
 * Days in scope order, each with its matters and their suggestions. Matters
 * are read after the suggestions, in a separate statement, so one can be
 * deleted in between; its suggestions are gone with it and are left out, and a
 * day left with no matter is left out too.
 */
export const groupSuggestionDays = <
  Scope extends DayScope,
  Item extends { durationMinutes: number },
>(
  scopes: readonly Scope[],
  matterFor: (
    workspaceId: SafeId<"workspace">,
  ) => SuggestionMatterLabel | undefined,
  serialize: (scope: Scope) => Item[],
): SuggestionDay<Item>[] => {
  const days: SuggestionDay<Item>[] = [];
  for (const scope of scopes) {
    const matter = matterFor(scope.workspaceId);
    if (matter === undefined) {
      continue;
    }
    const items = serialize(scope);
    let day = days.at(-1);
    if (day?.date !== scope.date) {
      day = { date: scope.date, matters: [] };
      days.push(day);
    }
    day.matters.push({
      matter,
      activeMinutes: items.reduce((sum, item) => sum + item.durationMinutes, 0),
      items,
    });
  }
  return days;
};

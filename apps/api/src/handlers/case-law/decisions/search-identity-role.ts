import {
  type DecisionQueryIntent,
  isWholeEntryIdentifier,
} from "@stll/api-contract/decision-query-intent";

/**
 * What a search entry's identifier does to the answer.
 *
 * - `answer`: the entry is a reference and nothing else, so the decisions it
 *   names are the answer, and the text index is read only when none does.
 * - `pin`: the entry carries a reference among other words. The words are a
 *   text search like any other, with its facets, total and pages, and the
 *   decisions the reference names are shown above its results rather than
 *   instead of them.
 * - `none`: no reference, or a continuation page of a text search that an
 *   entry answered by identity never has.
 */
export type SearchIdentityRole = "answer" | "pin" | "none";

export const searchIdentityRole = (
  intent: DecisionQueryIntent,
  { paging }: { paging: boolean },
): SearchIdentityRole => {
  if (intent.type !== "identifier") {
    return "none";
  }
  if (!isWholeEntryIdentifier(intent)) {
    return "pin";
  }
  return paging ? "none" : "answer";
};

/**
 * A page of text results with the decisions a reference names above it. A
 * named decision is shown once: the text ranking's copy of it is dropped, on
 * the first page where it is pinned and on every later page, so paging never
 * repeats it.
 */
export const withPinnedDecisions = <THit extends { id: string }>({
  pinned,
  pinnedIds,
  ranked,
}: {
  /** The named decisions shown on this page, in their own order. */
  pinned: readonly THit[];
  /** Every decision the reference names, shown here or on the first page. */
  pinnedIds: ReadonlySet<string>;
  ranked: readonly THit[];
}): THit[] => [
  ...pinned,
  ...ranked.filter(
    (hit) =>
      !pinnedIds.has(hit.id) && !pinned.some((shown) => shown.id === hit.id),
  ),
];

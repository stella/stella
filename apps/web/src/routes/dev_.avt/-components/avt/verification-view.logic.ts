/**
 * Pure presentation logic for a claim span in the document view, kept
 * separate from the component so it can be tested independently of
 * React and of the sample data. Deliberately takes only the two facts
 * that determine the answer - whether THIS claim matches the active
 * filter, and whether a filter is active at all - rather than a claim
 * or filter value, so a caller can't accidentally compute "matches"
 * once per paragraph and apply it to every claim in it (the bug this
 * replaced: dimming was computed per paragraph, so a paragraph with
 * one matching and one non-matching claim left the non-matching one
 * undimmed).
 */
export const spanPresentation = ({
  matches,
  filterActive,
}: {
  matches: boolean;
  filterActive: boolean;
}): { dim: boolean; highlight: boolean } => ({
  dim: filterActive && !matches,
  highlight: filterActive && matches,
});

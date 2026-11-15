/**
 * The words every review feature that carries a reviewer's work to a re-run
 * uses for what became of each reviewed item. Kept apart from the
 * carry-over core's query so the schema's enums can import it without
 * database code.
 */

/**
 * What became of one reviewed item when the next run of its document
 * completed. `carried`: every decision followed; `text-changed`: the matching
 * item's words or evidence changed, so decisions taken on the old ones were
 * withdrawn; `verdict-changed`: the new run reached another verdict, or
 * measured it against another standard, so decisions taken on the old one
 * were withdrawn (notes and links may still follow where a feature keeps
 * them); `unmatched`: nothing in the new run matches; `ambiguous`: more than
 * one thing could.
 */
export const CARRY_OUTCOMES = [
  "carried",
  "text-changed",
  "verdict-changed",
  "unmatched",
  "ambiguous",
] as const;
export type CarryOutcome = (typeof CARRY_OUTCOMES)[number];

/** Outcomes that leave the new run with a matching item. */
export const MATCHED_CARRY_OUTCOMES = [
  "carried",
  "text-changed",
  "verdict-changed",
] as const satisfies readonly CarryOutcome[];

/**
 * What reviewers have actually done with a position, across the org's runs.
 *
 * Derived on the server from the findings themselves (no signals table), so
 * this module only reads the projection and turns it into the one line the
 * position editor shows. Every rule about what those counts mean lives here
 * rather than in JSX.
 */

import type {
  PlaybookPositionDecisions,
  PositionStandard,
} from "@/lib/knowledge/playbook-types";

/** Inferred from the playbook read rather than restated, so a change to what
 *  the server counts fails to compile in the editor that shows it. */
export type PositionDecisionSummary =
  PlaybookPositionDecisions[keyof PlaybookPositionDecisions];

/** Dismissed this often with nothing ever accepted, and the position is not a
 *  standard anyone holds: the editor says so instead of implying one. */
export const NO_SETTLED_POSITION_DISMISSALS = 3;

/** The decision projection a playbook detail carries, keyed by
 *  `position.sourceId`. A position no reviewer has ever judged has no entry. */
export const readPositionDecisions = (
  decisions: PlaybookPositionDecisions,
): ReadonlyMap<string, PositionDecisionSummary> =>
  new Map(Object.entries(decisions));

/** Whether the org has dismissed this position often enough, and accepted it
 *  never, that calling it a standard would misread the record. */
export const isUnsettledPosition = ({
  accepted,
  dismissed,
}: PositionDecisionSummary): boolean =>
  accepted === 0 && dismissed >= NO_SETTLED_POSITION_DISMISSALS;

/**
 * The wording a reviewer has already accepted for this position and the
 * position has no ideal language of its own, or `null` when there is nothing
 * to adopt. A reference standard is not offered the swap: its passages are the
 * standard, and replacing them is "Convert to rules", not an adoption.
 */
export const adoptableIdealText = ({
  standard,
  summary,
}: {
  standard: PositionStandard;
  summary: PositionDecisionSummary;
}): string | null => {
  if (standard.source !== "tiers" || standard.tiers.acceptable.ideal) {
    return null;
  }
  const text = summary.latestAcceptedFixText?.trim() ?? "";
  return text.length === 0 ? null : text;
};

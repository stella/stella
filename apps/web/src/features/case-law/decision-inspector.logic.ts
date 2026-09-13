/**
 * Opening a decision row in the inspector.
 *
 * A row of results behaves the way a document row in a matter behaves: it
 * opens beside the list rather than replacing it, so the reader keeps their
 * place in the results. The mapping from a row to the tab is pure, and the
 * active-row test reads the same tab id the tab was created under, so a row
 * cannot look open while another tab is showing.
 */

import { caseDecisionTabId } from "@/components/inspector/case-decision-view";
import type { Decision } from "@/features/case-law/components/decision-cells";

/** What `createCaseDecisionViewTab` needs, taken off one results row. */
export type DecisionTabTarget = {
  anchorId?: string | undefined;
  caseNumber: string;
  country: string;
  court: string;
  decisionId: string;
  language?: string | null | undefined;
  languageAlternates?: readonly unknown[] | null | undefined;
  slug?: string | null | undefined;
};

export const decisionTabTarget = (
  decision: Decision,
  anchorId?: string,
): DecisionTabTarget => ({
  caseNumber: decision.caseNumber,
  country: decision.country,
  court: decision.court,
  decisionId: decision.id,
  language: decision.language,
  languageAlternates: decision.languageAlternates,
  slug: decision.slug,
  ...(anchorId === undefined ? {} : { anchorId }),
});

/** What marking a row as open needs: the version that matched, and its translations. */
type DecisionRowIdentity = {
  id: string;
  languageAlternates: readonly { id: string }[];
};

/**
 * Whether this row is the one the inspector is showing. One row stands for
 * every language version of its decision, and its links open whichever the
 * reader is most likely to want, so any of those tabs marks it. Compared on
 * the tab id rather than on a decision id kept beside it, so the row's
 * highlight and the tab that is open can never disagree.
 */
export const isDecisionRowActive = (
  activeTabId: string | null,
  decision: DecisionRowIdentity,
): boolean =>
  activeTabId !== null &&
  [decision.id, ...decision.languageAlternates.map(({ id }) => id)].some(
    (id) => caseDecisionTabId(id) === activeTabId,
  );

import { DECISION_DOCUMENT_ROLE } from "@stll/api-contract/decision-document-role";
import type { DecisionDocumentRole } from "@stll/api-contract/decision-document-role";

/**
 * What a supplement to a decision is: a document the publisher serves under
 * its own id that belongs inside another decision's document rather than
 * beside it.
 *
 * A leaf module using the shared role vocabulary; the database schema declares a
 * CHECK over these values and the ingestion types read them: both sides have
 * to be the same list.
 */
export const DECISION_SUPPLEMENT_KINDS = ["reasons"] as const;

export type DecisionSupplementKind = (typeof DECISION_SUPPLEMENT_KINDS)[number];

export const DECISION_SUPPLEMENT_KIND = {
  /** The written reasons for a ruling, published after it under an id of their own. */
  REASONS: "reasons",
} as const satisfies Record<string, DecisionSupplementKind>;

export const DECISION_SUPPLEMENT_DOCUMENT_ROLE = {
  [DECISION_SUPPLEMENT_KIND.REASONS]: DECISION_DOCUMENT_ROLE.REASONS,
} as const satisfies Record<DecisionSupplementKind, DecisionDocumentRole>;

import {
  DECISION_DOCUMENT_ROLE,
  type DecisionDocumentRole,
} from "@stll/api-contract/decision-document-role";

import {
  DECISION_SUPPLEMENT_KIND,
  type DecisionSupplementKind,
} from "@/api/lib/legal-search/decision-supplement-kind";

export const DECISION_SUPPLEMENT_DOCUMENT_ROLE = {
  [DECISION_SUPPLEMENT_KIND.REASONS]: DECISION_DOCUMENT_ROLE.REASONS,
} as const satisfies Record<DecisionSupplementKind, DecisionDocumentRole>;

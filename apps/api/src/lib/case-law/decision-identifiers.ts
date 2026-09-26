import {
  DECISION_IDENTIFIER_TYPES,
  isDecisionIdentifier,
} from "@stll/legal-ast/decision-identifier";
import type {
  DecisionIdentifier,
  DecisionIdentifiers,
  DecisionPrimaryReferenceType,
} from "@stll/legal-ast/decision-identifier";

import { primaryDecisionIdentifier } from "@/api/lib/legal-search/decision-primary-reference";

type LegacyDecisionIdentifierFields = {
  caseNumber: string;
  /** The row's `case_number_type`, so the fallback never guesses a docket. */
  caseNumberType: DecisionPrimaryReferenceType;
  ecli: string | null;
};

export const legacyDecisionIdentifiers = ({
  caseNumber,
  caseNumberType,
  ecli,
}: LegacyDecisionIdentifierFields): DecisionIdentifiers => {
  const caseNumberIdentifier = primaryDecisionIdentifier({
    caseNumber,
    caseNumberType,
  });
  return ecli === null
    ? [caseNumberIdentifier]
    : [
        caseNumberIdentifier,
        { type: DECISION_IDENTIFIER_TYPES.ECLI, value: ecli },
      ];
};

export const decisionIdentifierProjection = (
  value: unknown,
  legacy: LegacyDecisionIdentifierFields,
): DecisionIdentifiers => {
  const identifiers: DecisionIdentifier[] = Array.isArray(value)
    ? value.filter(isDecisionIdentifier)
    : [];
  const [first, ...rest] = identifiers;
  return first === undefined
    ? legacyDecisionIdentifiers(legacy)
    : [first, ...rest];
};

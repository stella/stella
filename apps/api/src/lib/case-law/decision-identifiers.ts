import {
  DECISION_IDENTIFIER_TYPES,
  isDecisionIdentifier,
} from "@stll/legal-ast/decision-identifier";
import type {
  DecisionIdentifier,
  DecisionIdentifiers,
} from "@stll/legal-ast/decision-identifier";

type LegacyDecisionIdentifierFields = {
  caseNumber: string;
  ecli: string | null;
};

export const legacyDecisionIdentifiers = ({
  caseNumber,
  ecli,
}: LegacyDecisionIdentifierFields): DecisionIdentifiers => {
  const caseNumberIdentifier = {
    type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    value: caseNumber,
  } as const;
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

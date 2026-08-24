import {
  isDecisionIdentifier,
  type DecisionIdentifier,
  type DecisionIdentifiers,
} from "@stll/legal-ast/decision-identifier";

const STORED_DECISION_IDENTIFIERS_METADATA_KEY = "_stellaDecisionIdentifiers";

export const storeDecisionIdentifiersInMetadata = (
  metadata: Record<string, unknown>,
  identifiers: DecisionIdentifiers | undefined,
): Record<string, unknown> => {
  const stored = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => key !== STORED_DECISION_IDENTIFIERS_METADATA_KEY,
    ),
  );
  if (identifiers !== undefined) {
    stored[STORED_DECISION_IDENTIFIERS_METADATA_KEY] = identifiers;
  }
  return stored;
};

export const decisionIdentifiersFromPersistedMetadata = (
  metadata: Record<string, unknown>,
): DecisionIdentifier[] | null => {
  const value = metadata[STORED_DECISION_IDENTIFIERS_METADATA_KEY];
  if (!Array.isArray(value)) {
    return null;
  }
  const candidates: unknown[] = value;
  return candidates.filter(isDecisionIdentifier);
};

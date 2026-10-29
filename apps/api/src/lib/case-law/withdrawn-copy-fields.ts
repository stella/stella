const DECISION_REFERENCE_SUFFIXES = [
  "decisionid",
  "decisionids",
  "decision_id",
  "decision_ids",
] as const;
type DecisionReferenceKey =
  `${string}${(typeof DECISION_REFERENCE_SUFFIXES)[number]}`;
export const isDecisionReferenceKey = (key: string): boolean =>
  DECISION_REFERENCE_SUFFIXES.some((suffix) =>
    key.toLowerCase().endsWith(suffix),
  );

export type IsDecisionReferenceKey<Key> = Key extends string
  ? Lowercase<Key> extends DecisionReferenceKey
    ? true
    : false
  : false;

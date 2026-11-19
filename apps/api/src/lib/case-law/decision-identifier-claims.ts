/** Support independent of a currently attached publisher post. */
export const DECISION_IDENTIFIER_CLAIM = {
  HOST: "host",
  RETIRED_ALIAS: "retired-alias",
  UNVERIFIED: "unverified",
} as const;
export const DECISION_IDENTIFIER_CLAIMS = Object.values(
  DECISION_IDENTIFIER_CLAIM,
);
export type DecisionIdentifierClaim =
  (typeof DECISION_IDENTIFIER_CLAIM)[keyof typeof DECISION_IDENTIFIER_CLAIM];

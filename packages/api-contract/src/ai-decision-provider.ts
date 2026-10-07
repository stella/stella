export const DECISION_MODEL_PROVIDERS = ["typesafe", "openai"] as const;
export type DecisionModelProvider = (typeof DECISION_MODEL_PROVIDERS)[number];

export const DEFAULT_OPENAI_DECISION_MODEL = "gpt-6-luna";

export const DECISION_UNDECIDED_REASONS = [
  "no-backend",
  "below-floor",
  "failed",
  "refusal",
] as const;
export type DecisionUndecidedReason =
  (typeof DECISION_UNDECIDED_REASONS)[number];

export const DECISION_UNDECIDED_REASON_CODES = {
  "no-backend": "no_decision_model",
  "below-floor": "below_floor",
  failed: "failed",
  refusal: "refusal",
} as const satisfies Record<DecisionUndecidedReason, string>;

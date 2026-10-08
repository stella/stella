export const DECISION_MODEL_PROVIDERS = ["typesafe", "openai"] as const;
export type DecisionModelProvider = (typeof DECISION_MODEL_PROVIDERS)[number];

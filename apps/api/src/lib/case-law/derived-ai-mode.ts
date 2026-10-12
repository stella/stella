// parser-output-unchanged: decides whether a model is asked for derived layers; parsed records are untouched.
/**
 * Whether this deployment asks a model for a case-law decision's derived
 * layers: the analysis generated when a reader opens a decision without one,
 * and the significance statement refreshed from the citation graph.
 *
 * - `off` Stored analyses are served as they are; nothing is generated or
 *         refreshed, so no request reaches a model. The default, which is
 *         what a local, seeded or CI stack runs with.
 * - `on`  Missing analyses are generated and stale significance refreshed.
 *         The production deployment sets this explicitly.
 *
 * Resolved once in `env-base`. A leaf module with no imports, because
 * `env-base` imports it.
 */
export const CASE_LAW_DERIVED_AI_MODES = ["off", "on"] as const;

export type CaseLawDerivedAiMode = (typeof CASE_LAW_DERIVED_AI_MODES)[number];

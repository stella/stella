/**
 * Why an organization's model run was refused at its caps: too many runs of
 * its kind are queued or running, or it has started its daily allowance.
 * Every capped kind (list verifications and fact extractions, document
 * reviews) answers with these two codes, so an agent, the CLI and the web
 * branch on the refusal without knowing which feature raised it.
 */
export const MODEL_RUN_CAP_CODES = {
  active: "run_active_limit_reached",
  daily: "run_daily_limit_reached",
} as const;

export type ModelRunCapCode =
  (typeof MODEL_RUN_CAP_CODES)[keyof typeof MODEL_RUN_CAP_CODES];

export const VERIFICATION_RUN_CAP_CODES = {
  active: "verification_active_limit_reached",
  daily: "verification_daily_limit_reached",
} as const;

export type VerificationRunCapCode =
  (typeof VERIFICATION_RUN_CAP_CODES)[keyof typeof VERIFICATION_RUN_CAP_CODES];

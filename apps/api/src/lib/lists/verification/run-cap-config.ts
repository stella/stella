import * as v from "valibot";

export const DEFAULT_VERIFICATION_RUN_CAPS = {
  active: 2,
  startsPerDay: 20,
} as const;

export type VerificationRunCaps = {
  active: number;
  startsPerDay: number;
};

export const verificationRunCapEnvSchema = {
  LIST_VERIFICATION_ACTIVE_RUNS_MAX: v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(100),
    ),
    String(DEFAULT_VERIFICATION_RUN_CAPS.active),
  ),
  LIST_VERIFICATION_DAILY_STARTS_MAX: v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(1000),
    ),
    String(DEFAULT_VERIFICATION_RUN_CAPS.startsPerDay),
  ),
};

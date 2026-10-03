import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { RUNTIME_MODE, type RuntimeMode } from "@stll/runtime-mode";
import { DAY_IN_MS, Temporal } from "@stll/time";

export const DEMO_ACCOUNT_OTP_MAX_AGE_DAYS = 7;
export const DEMO_ACCOUNT_OTP_MAX_AGE_MS =
  DEMO_ACCOUNT_OTP_MAX_AGE_DAYS * DAY_IN_MS;

const rotationInstant = (value: string) =>
  Temporal.Instant.from(value.length === 10 ? `${value}T00:00:00Z` : value);

export const demoAccountOtpRotatedAtSchema = v.pipe(
  v.union([
    v.pipe(v.string(), v.isoDate()),
    v.pipe(v.string(), v.isoTimestamp()),
  ]),
  v.check(
    (value) => Result.isOk(Result.try(() => rotationInstant(value))),
    "DEMO_ACCOUNT_OTP_ROTATED_AT must be a valid ISO date or timestamp.",
  ),
  v.brand("DemoAccountOtpRotatedAt"),
);

export class DemoAccountOtpConfigurationError extends TaggedError(
  "DemoAccountOtpConfigurationError",
)<{ message: string; reason: "missing" | "expired" | "future" }> {}

type DemoAccountOtpRotationOptions = {
  demoOtp: string | undefined;
  rotatedAt: v.InferOutput<typeof demoAccountOtpRotatedAtSchema> | undefined;
  runtimeMode: RuntimeMode;
  now: number;
};

export const validateDemoAccountOtpRotation = ({
  demoOtp,
  rotatedAt,
  runtimeMode,
  now,
}: DemoAccountOtpRotationOptions): Result<
  void,
  DemoAccountOtpConfigurationError
> => {
  if (runtimeMode.mode === RUNTIME_MODE.open || demoOtp === undefined) {
    return Result.ok(undefined);
  }
  if (rotatedAt === undefined) {
    return Result.err(
      new DemoAccountOtpConfigurationError({
        reason: "missing",
        message:
          "DEMO_ACCOUNT_OTP requires DEMO_ACCOUNT_OTP_ROTATED_AT in strict runtime mode.",
      }),
    );
  }
  const age = now - rotationInstant(rotatedAt).epochMilliseconds;
  if (age < 0) {
    return Result.err(
      new DemoAccountOtpConfigurationError({
        reason: "future",
        message: "DEMO_ACCOUNT_OTP_ROTATED_AT must not be in the future.",
      }),
    );
  }
  if (age > DEMO_ACCOUNT_OTP_MAX_AGE_MS) {
    return Result.err(
      new DemoAccountOtpConfigurationError({
        reason: "expired",
        message: `DEMO_ACCOUNT_OTP must be rotated within ${DEMO_ACCOUNT_OTP_MAX_AGE_DAYS} days; update DEMO_ACCOUNT_OTP and DEMO_ACCOUNT_OTP_ROTATED_AT together.`,
      }),
    );
  }
  return Result.ok(undefined);
};

type DemoAccountOtpRotationProbeOptions = Omit<
  DemoAccountOtpRotationOptions,
  "now"
> & {
  now: () => number;
};

export const createDemoAccountOtpRotationProbe =
  ({
    demoOtp,
    rotatedAt,
    runtimeMode,
    now,
  }: DemoAccountOtpRotationProbeOptions) =>
  async (): Promise<void> => {
    const rotation = validateDemoAccountOtpRotation({
      demoOtp,
      rotatedAt,
      runtimeMode,
      now: now(),
    });
    if (Result.isError(rotation)) {
      await Promise.reject(rotation.error);
    }
  };

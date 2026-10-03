import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { RUNTIME_MODE } from "@stll/runtime-mode";
import { Temporal } from "@stll/time";

import {
  DEMO_ACCOUNT_OTP_MAX_AGE_MS,
  DemoAccountOtpConfigurationError,
  demoAccountOtpRotatedAtSchema,
  validateDemoAccountOtpRotation,
} from "./demo-account-otp-rotation";

const rotatedAt = v.parse(
  demoAccountOtpRotatedAtSchema,
  "2021-03-04T10:00:00Z",
);
const rotatedAtMs = Temporal.Instant.from(rotatedAt).epochMilliseconds;
const configured = {
  demoOtp: "654321",
  rotatedAt,
  runtimeMode: { mode: RUNTIME_MODE.strict },
} as const satisfies Omit<
  Parameters<typeof validateDemoAccountOtpRotation>[0],
  "now"
>;

describe("demo credential rotation", () => {
  test("accepts the full configured age interval", () => {
    for (const age of [
      0,
      1,
      DEMO_ACCOUNT_OTP_MAX_AGE_MS - 1,
      DEMO_ACCOUNT_OTP_MAX_AGE_MS,
    ]) {
      expect(
        Result.isOk(
          validateDemoAccountOtpRotation({
            ...configured,
            now: rotatedAtMs + age,
          }),
        ),
      ).toBe(true);
    }
  });

  test("reports configured rotation requirements with typed reasons", () => {
    for (const input of [
      {
        ...configured,
        rotatedAt: undefined,
        now: rotatedAtMs,
        reason: "missing",
      },
      { ...configured, now: rotatedAtMs - 1, reason: "future" },
      {
        ...configured,
        rotatedAt: "invalid-date",
        now: rotatedAtMs,
        reason: "invalid",
      },
      {
        ...configured,
        now: rotatedAtMs + DEMO_ACCOUNT_OTP_MAX_AGE_MS + 1,
        reason: "expired",
      },
    ] as const) {
      const result = validateDemoAccountOtpRotation(input);
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toBeInstanceOf(DemoAccountOtpConfigurationError);
        expect(result.error.reason).toBe(input.reason);
        expect(result.error.message).toContain("DEMO_ACCOUNT_OTP");
        expect(result.error.message).not.toContain(configured.demoOtp);
      }
    }
  });

  test("allows unconfigured credentials and local development", () => {
    expect(
      Result.isOk(
        validateDemoAccountOtpRotation({
          ...configured,
          demoOtp: undefined,
          rotatedAt: undefined,
          now: rotatedAtMs,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isOk(
        validateDemoAccountOtpRotation({
          ...configured,
          rotatedAt: undefined,
          runtimeMode: { mode: RUNTIME_MODE.open },
          now: rotatedAtMs,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isOk(
        validateDemoAccountOtpRotation({
          ...configured,
          runtimeMode: { mode: RUNTIME_MODE.open },
          now: rotatedAtMs + DEMO_ACCOUNT_OTP_MAX_AGE_MS + 1,
        }),
      ),
    ).toBe(true);
  });
});

test("rotation dates use valid ISO calendar values", () => {
  for (const value of [
    "2021-03-04",
    "2021-03-04T10:00:00Z",
    "2021-03-04T10:00:00+01:00",
  ]) {
    expect(v.safeParse(demoAccountOtpRotatedAtSchema, value).success).toBe(
      true,
    );
  }
  for (const value of [
    "March 4 2021",
    "2021-02-30",
    "2021-02-30T10:00:00Z",
    "2021-13-04",
    "2021-03-04T25:00:00Z",
  ]) {
    expect(v.safeParse(demoAccountOtpRotatedAtSchema, value).success).toBe(
      false,
    );
  }
});

import { describe, expect, it } from "bun:test";

import { Temporal } from "@stll/time";

import { resolveDemoAccountOtp } from "@/api/lib/demo-account-otp-policy";
import { DEMO_ACCOUNT_OTP_MAX_AGE_MS } from "@/api/lib/demo-account-otp-rotation";
import type { DemoAccountOtpConfigurationError } from "@/api/lib/demo-account-otp-rotation";

const ROTATION = {
  rotatedAt: "2021-03-04T10:00:00Z",
  now: Temporal.Instant.from("2021-03-04T10:00:00Z").epochMilliseconds,
  runtimeMode: { mode: "strict" },
  warn: () => undefined,
} as const;

const CONFIGURED = {
  ...ROTATION,
  demoEmail: "demo@example.com",
  demoOtp: "123456",
};

describe("resolveDemoAccountOtp", () => {
  it("uses configured sign-in codes only while their rotation is current", () => {
    const warnings: DemoAccountOtpConfigurationError[] = [];
    const signIn = {
      ...CONFIGURED,
      email: CONFIGURED.demoEmail,
      type: "sign-in",
      warn: (error: DemoAccountOtpConfigurationError) => warnings.push(error),
    } as const;
    expect(resolveDemoAccountOtp(signIn)).toBe(CONFIGURED.demoOtp);
    expect(
      resolveDemoAccountOtp({
        ...signIn,
        now: ROTATION.now + DEMO_ACCOUNT_OTP_MAX_AGE_MS,
      }),
    ).toBe(CONFIGURED.demoOtp);
    expect(warnings).toHaveLength(0);
    for (const input of [
      { ...signIn, rotatedAt: undefined, reason: "missing" },
      { ...signIn, rotatedAt: "invalid-date", reason: "invalid" },
      { ...signIn, rotatedAt: "2021-03-04T10:00:01Z", reason: "future" },
      {
        ...signIn,
        now: ROTATION.now + DEMO_ACCOUNT_OTP_MAX_AGE_MS + 1,
        reason: "expired",
      },
    ] as const) {
      expect(resolveDemoAccountOtp(input)).toBeUndefined();
      expect(warnings.at(-1)?.reason).toBe(input.reason);
    }
    expect(warnings).toHaveLength(4);
    expect(
      resolveDemoAccountOtp({
        ...signIn,
        runtimeMode: { mode: "open" },
        rotatedAt: undefined,
      }),
    ).toBe(CONFIGURED.demoOtp);
    expect(warnings).toHaveLength(4);
  });

  it("returns the fixed code only for the configured address on sign-in", () => {
    expect(
      resolveDemoAccountOtp({
        email: "demo@example.com",
        type: "sign-in",
        ...CONFIGURED,
      }),
    ).toBe("123456");
  });

  it("normalizes case and whitespace before matching", () => {
    expect(
      resolveDemoAccountOtp({
        email: "  Demo@Example.COM ",
        type: "sign-in",
        ...CONFIGURED,
      }),
    ).toBe("123456");
  });

  it("never overrides non-sign-in OTP types", () => {
    for (const type of [
      "email-verification",
      "forget-password",
      "change-email",
    ] as const) {
      expect(
        resolveDemoAccountOtp({
          email: "demo@example.com",
          type,
          ...CONFIGURED,
        }),
      ).toBeUndefined();
    }
  });

  it("ignores other addresses and half-configured env", () => {
    expect(
      resolveDemoAccountOtp({
        email: "other@example.com",
        type: "sign-in",
        ...CONFIGURED,
      }),
    ).toBeUndefined();
    expect(
      resolveDemoAccountOtp({
        email: "demo@example.com",
        type: "sign-in",
        ...ROTATION,
        demoEmail: "demo@example.com",
        demoOtp: undefined,
      }),
    ).toBeUndefined();
    expect(
      resolveDemoAccountOtp({
        email: "demo@example.com",
        type: "sign-in",
        ...ROTATION,
        demoEmail: undefined,
        demoOtp: "123456",
      }),
    ).toBeUndefined();
  });
});

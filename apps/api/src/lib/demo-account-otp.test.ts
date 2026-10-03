import { describe, expect, it } from "bun:test";

import { resolveDemoAccountOtp } from "@/api/lib/demo-account-otp-policy";

const CONFIGURED = {
  demoEmail: "demo@example.com",
  demoOtp: "123456",
  warn: () => undefined,
};

describe("configured sign-in codes", () => {
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
        demoEmail: " Demo@EXAMPLE.com ",
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
    let warnings = 0;
    expect(
      resolveDemoAccountOtp({
        email: "other@example.com",
        type: "sign-in",
        ...CONFIGURED,
        warn: () => {
          warnings++;
        },
      }),
    ).toBeUndefined();
    expect(warnings).toBe(1);
    expect(
      resolveDemoAccountOtp({
        email: "demo@example.com",
        type: "sign-in",
        warn: () => undefined,
        demoEmail: "demo@example.com",
        demoOtp: undefined,
      }),
    ).toBeUndefined();
    expect(
      resolveDemoAccountOtp({
        email: "demo@example.com",
        type: "sign-in",
        warn: () => undefined,
        demoEmail: undefined,
        demoOtp: "123456",
      }),
    ).toBeUndefined();
  });
});

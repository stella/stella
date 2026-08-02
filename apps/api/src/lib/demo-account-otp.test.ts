import { describe, expect, it } from "bun:test";

import { resolveDemoAccountOtp } from "@/api/lib/demo-account-otp";

const CONFIGURED = {
  demoEmail: "demo@example.com",
  demoOtp: "123456",
};

describe("resolveDemoAccountOtp", () => {
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
        demoEmail: "demo@example.com",
        demoOtp: undefined,
      }),
    ).toBeUndefined();
    expect(
      resolveDemoAccountOtp({
        email: "demo@example.com",
        type: "sign-in",
        demoEmail: undefined,
        demoOtp: "123456",
      }),
    ).toBeUndefined();
  });
});

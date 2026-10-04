import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { resolveDemoAccountOtp } from "@/api/lib/auth/demo-account-otp-policy";

const CONFIGURED = {
  demoEmail: "demo@example.com",
  demoOtp: "123456",
  warn: () => undefined,
};

describe("configured sign-in codes", () => {
  it("returns the fixed code only for an address equal to the configured one", () => {
    assertProperty(
      "returns the fixed code only for an address equal to the configured one",
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.constantFrom("prefix", "suffix", "subdomain", "plus"),
        (extra, shape) => {
          const email = {
            prefix: `${extra}demo@example.com`,
            suffix: `demo@example.com${extra}`,
            subdomain: `demo@${extra}.example.com`,
            plus: `demo+${extra}@example.com`,
          }[shape];
          const matches = email.trim().toLowerCase() === CONFIGURED.demoEmail;
          expect(
            resolveDemoAccountOtp({ email, type: "sign-in", ...CONFIGURED }),
          ).toBe(matches ? CONFIGURED.demoOtp : undefined);
        },
      ),
    );
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

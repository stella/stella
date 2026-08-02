import { describe, expect, test } from "bun:test";

import { NEW_ACCOUNT_OTP_RATE_LIMITS } from "@/api/lib/limits";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";

import {
  consumeNewAccountOtpRateLimit,
  evaluateNewAccountOtpPolicy,
  isDisposableEmailAddress,
} from "./signup-abuse";

describe("new-account OTP abuse policy", () => {
  test("recognizes disposable domains across harmless email normalization", () => {
    const disposableEmails = [
      "user@mailinator.com",
      " USER@MAILINATOR.COM ",
      "user@subdomain.mailinator.com",
      "user@10minutemail.com.",
    ];
    for (const email of disposableEmails) {
      expect(isDisposableEmailAddress(email)).toBe(true);
    }

    const permanentEmails = ["user@example.com", "user@gmail.com"];
    for (const email of permanentEmails) {
      expect(isDisposableEmailAddress(email)).toBe(false);
    }
  });

  test("allows an existing account even when its domain is now blocked", async () => {
    const result = await evaluateNewAccountOtpPolicy({
      accountExists: async (email) => email === "user@mailinator.com",
      clientIp: "192.0.2.1",
      context: {
        increment: async () => {
          throw new Error("existing accounts must not consume signup limits");
        },
      },
      email: " USER@MAILINATOR.COM ",
    });

    expect(result).toEqual({
      status: "allowed",
      reason: "existing_account",
    });
  });

  test("rejects a new disposable address before consuming rate limits", async () => {
    const result = await evaluateNewAccountOtpPolicy({
      accountExists: async () => false,
      clientIp: "192.0.2.1",
      context: {
        increment: async () => {
          throw new Error(
            "disposable addresses must not consume signup limits",
          );
        },
      },
      email: "new-user@mailinator.com",
    });

    expect(result).toEqual({
      status: "rejected",
      reason: "disposable_email",
    });
  });

  test("limits repeated attempts per normalized email without coupling other emails", async () => {
    const context = new InMemoryRateLimitContext();
    try {
      for (
        let index = 0;
        index < NEW_ACCOUNT_OTP_RATE_LIMITS.email.max;
        index += 1
      ) {
        // oxlint-disable-next-line no-await-in-loop -- sequential increments exercise one fixed-window counter
        const result = await consumeNewAccountOtpRateLimit({
          clientIp: null,
          context,
          normalizedEmail: "new-user@example.com",
        });
        expect(result.status).toBe("allowed");
      }

      expect(
        (
          await consumeNewAccountOtpRateLimit({
            clientIp: null,
            context,
            normalizedEmail: "new-user@example.com",
          })
        ).status,
      ).toBe("rate_limited");
      expect(
        (
          await consumeNewAccountOtpRateLimit({
            clientIp: null,
            context,
            normalizedEmail: "other-user@example.com",
          })
        ).status,
      ).toBe("allowed");
    } finally {
      context.kill();
    }
  });

  test("limits new-account attempts across email addresses from one IP", async () => {
    const context = new InMemoryRateLimitContext();
    try {
      for (
        let index = 0;
        index < NEW_ACCOUNT_OTP_RATE_LIMITS.ip.max;
        index += 1
      ) {
        // oxlint-disable-next-line no-await-in-loop -- sequential increments exercise one fixed-window counter
        const result = await consumeNewAccountOtpRateLimit({
          clientIp: "192.0.2.1",
          context,
          normalizedEmail: `new-user-${index}@example.com`,
        });
        expect(result.status).toBe("allowed");
      }

      const overflow = await consumeNewAccountOtpRateLimit({
        clientIp: "192.0.2.1",
        context,
        normalizedEmail: "overflow@example.com",
      });
      expect(overflow.status).toBe("rate_limited");
      if (overflow.status === "rate_limited") {
        expect(overflow.reason).toBe("ip");
      }

      expect(
        (
          await consumeNewAccountOtpRateLimit({
            clientIp: "192.0.2.2",
            context,
            normalizedEmail: "other-ip@example.com",
          })
        ).status,
      ).toBe("allowed");
    } finally {
      context.kill();
    }
  });
});

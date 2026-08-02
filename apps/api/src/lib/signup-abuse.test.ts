import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { NEW_ACCOUNT_OTP_RATE_LIMITS } from "@/api/lib/limits";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";

import {
  consumeSignupOtpRateLimit,
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

  test("allows an existing account after consuming the shared email limit", async () => {
    const observedKeys: string[] = [];
    const result = await evaluateNewAccountOtpPolicy({
      accountExists: async (email) => email === "user@mailinator.com",
      clientIp: "192.0.2.1",
      context: {
        increment: async (key) => {
          observedKeys.push(key);
          return {
            count: 1,
            nextReset: new Date(Date.now() + 60_000),
            start: Date.now(),
          };
        },
      },
      email: " USER@MAILINATOR.COM ",
    });

    expect(result).toEqual({
      status: "allowed",
      reason: "existing_account",
    });
    expect(observedKeys).toHaveLength(1);
    expect(observedKeys.at(0)).toStartWith("auth:new-account-otp:email:");
  });

  test("rejects a new disposable address after the shared email limit", async () => {
    const observedKeys: string[] = [];
    const result = await evaluateNewAccountOtpPolicy({
      accountExists: async () => false,
      clientIp: "192.0.2.1",
      context: {
        increment: async (key) => {
          observedKeys.push(key);
          return {
            count: 1,
            nextReset: new Date(Date.now() + 60_000),
            start: Date.now(),
          };
        },
      },
      email: "new-user@mailinator.com",
    });

    expect(result).toEqual({
      status: "rejected",
      reason: "disposable_email",
    });
    expect(observedKeys).toHaveLength(1);
    expect(observedKeys.at(0)).toStartWith("auth:new-account-otp:email:");
  });

  test("pseudonymizes rate-limit identities with the deployment secret", async () => {
    const normalizedEmail = "new-user@example.com";
    const clientIp = "192.0.2.1";
    const observedKeys: string[] = [];
    const nextReset = new Date(Date.now() + 60_000);

    await consumeSignupOtpRateLimit({
      context: {
        increment: async (key) => {
          observedKeys.push(key);
          return { count: 1, nextReset, start: Date.now() };
        },
      },
      identity: normalizedEmail,
      kind: "email",
    });
    await consumeSignupOtpRateLimit({
      context: {
        increment: async (key) => {
          observedKeys.push(key);
          return { count: 1, nextReset, start: Date.now() };
        },
      },
      identity: clientIp,
      kind: "ip",
    });

    const keyedEmailDigest = new Bun.CryptoHasher(
      "sha256",
      env.BETTER_AUTH_SECRET,
    )
      .update(normalizedEmail)
      .digest("hex");
    const keyedIpDigest = new Bun.CryptoHasher("sha256", env.BETTER_AUTH_SECRET)
      .update(clientIp)
      .digest("hex");
    const unkeyedEmailDigest = new Bun.CryptoHasher("sha256")
      .update(normalizedEmail)
      .digest("hex");

    expect(observedKeys).toEqual([
      `auth:new-account-otp:email:${keyedEmailDigest}`,
      `auth:new-account-otp:ip:${keyedIpDigest}`,
    ]);
    expect(observedKeys.join(":")).not.toContain(normalizedEmail);
    expect(observedKeys.join(":")).not.toContain(clientIp);
    expect(observedKeys.join(":")).not.toContain(unkeyedEmailDigest);
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
        const result = await consumeSignupOtpRateLimit({
          context,
          identity: "new-user@example.com",
          kind: "email",
        });
        expect(result.status).toBe("allowed");
      }

      expect(
        (
          await consumeSignupOtpRateLimit({
            context,
            identity: "new-user@example.com",
            kind: "email",
          })
        ).status,
      ).toBe("rate_limited");
      expect(
        (
          await consumeSignupOtpRateLimit({
            context,
            identity: "other-user@example.com",
            kind: "email",
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
        const result = await consumeSignupOtpRateLimit({
          context,
          identity: "192.0.2.1",
          kind: "ip",
        });
        expect(result.status).toBe("allowed");
      }

      const overflow = await consumeSignupOtpRateLimit({
        context,
        identity: "192.0.2.1",
        kind: "ip",
      });
      expect(overflow.status).toBe("rate_limited");
      if (overflow.status === "rate_limited") {
        expect(overflow.reason).toBe("ip");
      }

      expect(
        (
          await consumeSignupOtpRateLimit({
            context,
            identity: "192.0.2.2",
            kind: "ip",
          })
        ).status,
      ).toBe("allowed");
    } finally {
      context.kill();
    }
  });

  test("returns the same email limit regardless of account existence", async () => {
    const overflowForAccountState = async (exists: boolean) => {
      const context = new InMemoryRateLimitContext();
      try {
        for (
          let index = 0;
          index < NEW_ACCOUNT_OTP_RATE_LIMITS.email.max;
          index += 1
        ) {
          // oxlint-disable-next-line no-await-in-loop -- sequential requests exercise one fixed-window counter
          await evaluateNewAccountOtpPolicy({
            accountExists: async () => exists,
            clientIp: null,
            context,
            email: "candidate@example.com",
          });
        }

        const overflow = await evaluateNewAccountOtpPolicy({
          accountExists: async () => exists,
          clientIp: null,
          context,
          email: "candidate@example.com",
        });
        return overflow;
      } finally {
        context.kill();
      }
    };

    const overflows = await Promise.all([
      overflowForAccountState(false),
      overflowForAccountState(true),
    ]);
    expect(overflows).toEqual([
      expect.objectContaining({ reason: "email", status: "rate_limited" }),
      expect.objectContaining({ reason: "email", status: "rate_limited" }),
    ]);
  });
});

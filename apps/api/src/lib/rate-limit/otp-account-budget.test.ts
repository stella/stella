import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { describe, expect, test } from "bun:test";

import {
  createOtpAccountBudget,
  createOtpAccountLimitPlugin,
  OTP_ACCOUNT_BUDGET,
} from "@/api/lib/rate-limit/otp-account-budget";

const createCounter = () => {
  let now = Date.now();
  const counters = new Map<string, { count: number; expiresAt: number }>();
  const counterKey = (key: string) => key.split("\u001f").at(0) ?? key;
  return {
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    context: {
      increment: async (
        key: string,
        duration = OTP_ACCOUNT_BUDGET.durationMs,
      ) => {
        const name = counterKey(key);
        const previous = counters.get(name);
        const current =
          previous && previous.expiresAt > now
            ? previous
            : { count: 0, expiresAt: now + duration };
        current.count += 1;
        counters.set(name, current);
        return {
          count: current.count,
          nextReset: new Date(current.expiresAt),
          start: current.expiresAt - duration,
        };
      },
      decrement: async (key: string) => {
        const current = counters.get(counterKey(key));
        if (current) {
          current.count -= 1;
        }
      },
    },
  };
};

describe("account verification budget", () => {
  test("counts unsuccessful verifications until the account window ends", async () => {
    const counter = createCounter();
    const budget = createOtpAccountBudget(counter.context);
    for (let attempt = 0; attempt < OTP_ACCOUNT_BUDGET.max; attempt += 1) {
      const key = await budget.reserve(
        attempt % 2 === 0 ? "account@example.test" : " ACCOUNT@EXAMPLE.TEST ",
      );
      await budget.complete(key, false);
    }
    await expect(budget.reserve("account@example.test")).rejects.toMatchObject({
      statusCode: 429,
    });
    counter.advance(OTP_ACCOUNT_BUDGET.durationMs);
    expect(await budget.reserve("account@example.test")).toBeTypeOf("string");
    expect(await budget.reserve("other@example.test")).toBeTypeOf("string");
  });

  test("successful verifications return their reservation", async () => {
    const budget = createOtpAccountBudget(createCounter().context);
    for (let attempt = 0; attempt < OTP_ACCOUNT_BUDGET.max * 2; attempt += 1) {
      await budget.complete(await budget.reserve("account@example.test"), true);
    }
  });

  test("bounds simultaneous account reservations", async () => {
    const budget = createOtpAccountBudget(createCounter().context);
    const outcomes = await Promise.allSettled(
      Array.from(
        { length: OTP_ACCOUNT_BUDGET.max * 2 },
        async () => await budget.reserve("account@example.test"),
      ),
    );
    expect(
      outcomes.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(OTP_ACCOUNT_BUDGET.max);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(APIError);
        expect(outcome.reason.statusCode).toBe(429);
      }
    }
  });

  test.each([false, true])(
    "retains the account budget across OTP requests: %s",
    async (valid) => {
      const counter = createCounter();
      const auth = betterAuth({
        baseURL: "http://localhost:3001",
        secret: "test-secret-that-is-long-enough-for-better-auth",
        database: memoryAdapter({
          user: [],
          session: [],
          account: [],
          verification: [],
        }),
        plugins: [
          createOtpAccountLimitPlugin({
            enabled: true,
            context: counter.context,
          }),
          emailOTP({
            generateOTP: () => "123456",
            sendVerificationOTP: async () => undefined,
          }),
        ],
      });
      for (let attempt = 0; attempt <= OTP_ACCOUNT_BUDGET.max; attempt += 1) {
        await auth.api.sendVerificationOTP({
          body: { email: "account@example.test", type: "sign-in" },
        });
        const response = await auth.api.signInEmailOTP({
          body: {
            email: "account@example.test",
            otp: valid ? "123456" : "654321",
          },
          asResponse: true,
        });
        const failureStatus = attempt < OTP_ACCOUNT_BUDGET.max ? 400 : 429;
        expect(response.status).toBe(valid ? 200 : failureStatus);
      }
    },
  );

  test("uses the authenticated account for email-change verification", async () => {
    const auth = betterAuth({
      baseURL: "http://localhost:3001",
      secret: "test-secret-that-is-long-enough-for-better-auth",
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
      }),
      plugins: [
        createOtpAccountLimitPlugin({
          enabled: true,
          context: createCounter().context,
        }),
        emailOTP({
          changeEmail: { enabled: true },
          generateOTP: () => "123456",
          sendVerificationOTP: async () => undefined,
        }),
      ],
    });
    await auth.api.sendVerificationOTP({
      body: { email: "account@example.test", type: "sign-in" },
    });
    const signedIn = await auth.api.signInEmailOTP({
      body: { email: "account@example.test", otp: "123456" },
      asResponse: true,
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";").at(0))
      .join("; ");
    expect(cookie).not.toBe("");
    for (let attempt = 0; attempt <= OTP_ACCOUNT_BUDGET.max; attempt += 1) {
      const response = await auth.api.changeEmailEmailOTP({
        body: { newEmail: `updated-${attempt}@example.test`, otp: "654321" },
        headers: { cookie },
        asResponse: true,
      });
      expect(response.status).toBe(
        attempt < OTP_ACCOUNT_BUDGET.max ? 400 : 429,
      );
    }
  });
});

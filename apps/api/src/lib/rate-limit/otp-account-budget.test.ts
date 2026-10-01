import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  createOtpAccountBudget,
  createOtpAccountLimitPlugin,
  OTP_ACCOUNT_BUDGET,
} from "@/api/lib/rate-limit/otp-account-budget";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

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

const reserveAllowed = async (
  budget: ReturnType<typeof createOtpAccountBudget>,
  email: string,
) => {
  const reservation = await budget.reserve(email);
  expect(Result.isOk(reservation)).toBe(true);
  return reservation.unwrap();
};

describe("account verification budget", () => {
  test("keeps a bounded local budget when the shared counter is unavailable", async () => {
    const context = new RedisRateLimitContext({
      failurePolicy: "fail_open_local",
      createRedis: () => ({
        send: async () => {
          throw new TypeError("Counter unavailable");
        },
      }),
      onRedisError: () => undefined,
    });
    context.init({
      duration: OTP_ACCOUNT_BUDGET.durationMs,
    });
    const budget = createOtpAccountBudget(context);
    try {
      for (
        let attempt = 0;
        attempt < OTP_ACCOUNT_BUDGET.max * 2;
        attempt += 1
      ) {
        await budget.complete(
          await reserveAllowed(budget, "account@example.test"),
          true,
        );
      }
      for (let attempt = 0; attempt < OTP_ACCOUNT_BUDGET.max; attempt += 1) {
        await budget.complete(
          await reserveAllowed(budget, "account@example.test"),
          false,
        );
      }
      expect(await budget.reserve("account@example.test")).toMatchObject({
        status: "error",
        error: { statusCode: 429 },
      });
      expect(await reserveAllowed(budget, "other@example.test")).toBeTypeOf(
        "string",
      );
    } finally {
      context.kill();
    }
  });

  test.each(["sign-in", "check", "verify-email", "reset-password"] as const)(
    "counts only live verifications for %s",
    async (path) => {
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
      await (
        await auth.$context
      ).internalAdapter.createUser(
        {
          email: "account@example.test",
          name: "Account",
          emailVerified: true,
        },
        { method: "email-otp" },
      );
      const verify = async (otp: string) => {
        const body = { email: "ACCOUNT@EXAMPLE.TEST", otp };
        switch (path) {
          case "sign-in":
            return await auth.api.signInEmailOTP({ body, asResponse: true });
          case "check":
            return await auth.api.checkVerificationOTP({
              body: { ...body, type: "sign-in" },
              asResponse: true,
            });
          case "verify-email":
            return await auth.api.verifyEmailOTP({ body, asResponse: true });
          case "reset-password":
            return await auth.api.resetPasswordEmailOTP({
              body: { ...body, password: "fixture-password" },
              asResponse: true,
            });
        }
      };
      for (let attempt = 0; attempt < 20; attempt += 1) {
        expect((await verify("654321")).status).toBe(400);
      }
      const type = {
        "sign-in": "sign-in",
        check: "sign-in",
        "verify-email": "email-verification",
        "reset-password": "forget-password",
      } as const;
      for (let attempt = 0; attempt <= 10; attempt += 1) {
        await auth.api.sendVerificationOTP({
          body: { email: "account@example.test", type: type[path] },
        });
        expect((await verify("654321")).status).toBe(attempt < 10 ? 400 : 429);
      }
      expect((await verify("123456")).status).toBe(429);
    },
  );

  test("excludes expired verification values from the account window", async () => {
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
    for (let attempt = 0; attempt < OTP_ACCOUNT_BUDGET.max * 2; attempt += 1) {
      await (
        await auth.$context
      ).internalAdapter.createVerificationValue({
        identifier: "sign-in-otp-account@example.test",
        value: "123456:0",
        expiresAt: new Date(Date.now() - 1000),
      });
      const response = await auth.api.signInEmailOTP({
        body: { email: "account@example.test", otp: "654321" },
        asResponse: true,
      });
      expect(response.status).toBe(400);
    }
    await auth.api.sendVerificationOTP({
      body: { email: "account@example.test", type: "sign-in" },
    });
    expect(
      (
        await auth.api.signInEmailOTP({
          body: { email: "account@example.test", otp: "123456" },
          asResponse: true,
        })
      ).status,
    ).toBe(200);
  });
  test("counts unsuccessful verifications until the account window ends", async () => {
    const counter = createCounter();
    const budget = createOtpAccountBudget(counter.context);
    for (let attempt = 0; attempt < OTP_ACCOUNT_BUDGET.max; attempt += 1) {
      const key = await reserveAllowed(
        budget,
        attempt % 2 === 0 ? "account@example.test" : " ACCOUNT@EXAMPLE.TEST ",
      );
      await budget.complete(key, false);
    }
    expect(await budget.reserve("account@example.test")).toMatchObject({
      status: "error",
      error: { statusCode: 429 },
    });
    counter.advance(OTP_ACCOUNT_BUDGET.durationMs);
    expect(await reserveAllowed(budget, "account@example.test")).toBeTypeOf(
      "string",
    );
    expect(await reserveAllowed(budget, "other@example.test")).toBeTypeOf(
      "string",
    );
  });

  test("successful verifications return their reservation", async () => {
    const budget = createOtpAccountBudget(createCounter().context);
    for (let attempt = 0; attempt < OTP_ACCOUNT_BUDGET.max * 2; attempt += 1) {
      await budget.complete(
        await reserveAllowed(budget, "account@example.test"),
        true,
      );
    }
  });

  test("bounds simultaneous account reservations", async () => {
    const budget = createOtpAccountBudget(createCounter().context);
    const outcomes = await Promise.all(
      Array.from(
        { length: OTP_ACCOUNT_BUDGET.max * 2 },
        async () => await budget.reserve("account@example.test"),
      ),
    );
    expect(outcomes.filter((outcome) => Result.isOk(outcome))).toHaveLength(
      OTP_ACCOUNT_BUDGET.max,
    );
    for (const outcome of outcomes) {
      if (Result.isError(outcome)) {
        expect(outcome.error).toBeInstanceOf(APIError);
        expect(outcome.error.statusCode).toBe(429);
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
    for (let attempt = 0; attempt < OTP_ACCOUNT_BUDGET.max * 2; attempt += 1) {
      const response = await auth.api.changeEmailEmailOTP({
        body: { newEmail: "updated@example.test", otp: "654321" },
        headers: { cookie },
        asResponse: true,
      });
      expect(response.status).toBe(400);
    }
    for (let attempt = 0; attempt <= OTP_ACCOUNT_BUDGET.max; attempt += 1) {
      const newEmail = `updated-${attempt}@example.test`;
      await auth.api.requestEmailChangeEmailOTP({
        body: { newEmail },
        headers: { cookie },
      });
      const response = await auth.api.changeEmailEmailOTP({
        body: { newEmail: newEmail.toUpperCase(), otp: "654321" },
        headers: { cookie },
        asResponse: true,
      });
      expect(response.status).toBe(
        attempt < OTP_ACCOUNT_BUDGET.max ? 400 : 429,
      );
    }
    expect(
      (
        await auth.api.changeEmailEmailOTP({
          body: {
            newEmail: `updated-${OTP_ACCOUNT_BUDGET.max}@example.test`,
            otp: "123456",
          },
          headers: { cookie },
          asResponse: true,
        })
      ).status,
    ).toBe(429);
  });

  test("includes current-account verification when requesting an email change", async () => {
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
          changeEmail: { enabled: true, verifyCurrentEmail: true },
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
    for (let attempt = 0; attempt < OTP_ACCOUNT_BUDGET.max * 2; attempt += 1) {
      expect(
        (
          await auth.api.requestEmailChangeEmailOTP({
            body: { newEmail: "updated@example.test", otp: "654321" },
            headers: { cookie },
            asResponse: true,
          })
        ).status,
      ).toBe(400);
    }
    for (let attempt = 0; attempt <= OTP_ACCOUNT_BUDGET.max; attempt += 1) {
      await auth.api.sendVerificationOTP({
        body: { email: "account@example.test", type: "email-verification" },
      });
      expect(
        (
          await auth.api.requestEmailChangeEmailOTP({
            body: { newEmail: "updated@example.test", otp: "654321" },
            headers: { cookie },
            asResponse: true,
          })
        ).status,
      ).toBe(attempt < OTP_ACCOUNT_BUDGET.max ? 400 : 429);
    }
    expect(
      (
        await auth.api.requestEmailChangeEmailOTP({
          body: { newEmail: "updated@example.test", otp: "123456" },
          headers: { cookie },
          asResponse: true,
        })
      ).status,
    ).toBe(429);
  });
});

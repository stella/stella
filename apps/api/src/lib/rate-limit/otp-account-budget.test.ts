import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  createOtpAccountBudget,
  createOtpAccountLimitPlugin,
  DEMO_OTP_ACCOUNT_BUDGET,
  OTP_ACCOUNT_BUDGET,
} from "@/api/lib/rate-limit/otp-account-budget";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

type PostAuthOptions = {
  path: string;
  body: Record<string, unknown>;
  headers?: { cookie: string };
};

const postAuth = async (
  auth: { handler: (request: Request) => Promise<Response> },
  { path, body, headers }: PostAuthOptions,
) => {
  const response = await auth.handler(
    new Request(`http://localhost:3001/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3001",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
  if (path === "/email-otp/send-verification-otp") {
    expect(response.status).toBe(200);
  }
  return response;
};

const createCounter = () => {
  let now = Date.now();
  const counters = new Map<string, { count: number; expiresAt: number }>();
  const counterKey = (key: string) => key.split("\u001f").at(0) ?? key;
  return {
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    context: {
      complete: async () => undefined,
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
  test("gives the demo account a smaller budget over the same window", () => {
    expect(DEMO_OTP_ACCOUNT_BUDGET).toEqual({
      max: 5,
      durationMs: OTP_ACCOUNT_BUDGET.durationMs,
    });
    expect(DEMO_OTP_ACCOUNT_BUDGET.max).toBeLessThan(OTP_ACCOUNT_BUDGET.max);
  });

  const nativeVerificationCases = [
    { path: "/sign-in/email-otp", type: "sign-in", extra: {} },
    {
      path: "/email-otp/check-verification-otp",
      type: "sign-in",
      extra: { type: "sign-in" },
    },
    { path: "/email-otp/verify-email", type: "email-verification", extra: {} },
    {
      path: "/email-otp/reset-password",
      type: "forget-password",
      extra: { password: "fixture-password" },
    },
  ] as const;
  test.each(
    nativeVerificationCases.flatMap(({ path, type, extra }) =>
      [false, true].map((enabled) => ({ path, type, extra, enabled })),
    ),
  )(
    "retains native per-code responses: %j",
    async ({ path, type, extra, enabled }) => {
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
            enabled,
            context: createCounter().context,
            demoAccountEmail: undefined,
          }),
          emailOTP({
            generateOTP: () => "123456",
            sendVerificationOTP: async () => undefined,
          }),
        ],
      });
      const context = await auth.$context;
      await context.internalAdapter.createUser(
        {
          email: "account@example.test",
          name: "Account",
          emailVerified: true,
        },
        { method: "email-otp" },
      );
      await postAuth(auth, {
        path: "/email-otp/send-verification-otp",
        body: { email: "account@example.test", type },
      });
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await postAuth(auth, {
          path,
          body: { email: "account@example.test", otp: "654321", ...extra },
        });
        expect(response.status).toBe(attempt < 3 ? 400 : 403);
        expect(await response.json()).toMatchObject({
          code: attempt < 3 ? "INVALID_OTP" : "TOO_MANY_ATTEMPTS",
        });
      }
    },
  );

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
    const budget = createOtpAccountBudget(context, undefined);
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
            demoAccountEmail: undefined,
          }),
          emailOTP({
            allowedAttempts: OTP_ACCOUNT_BUDGET.max + 1,
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
            return await postAuth(auth, { path: "/sign-in/email-otp", body });
          case "check":
            return await postAuth(auth, {
              path: "/email-otp/check-verification-otp",
              body: { ...body, type: "sign-in" },
            });
          case "verify-email":
            return await postAuth(auth, {
              path: "/email-otp/verify-email",
              body,
            });
          case "reset-password":
            return await postAuth(auth, {
              path: "/email-otp/reset-password",
              body: { ...body, password: "fixture-password" },
            });
          default:
            path satisfies never;
            return panic("Unknown verification path");
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
        await postAuth(auth, {
          path: "/email-otp/send-verification-otp",
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
          demoAccountEmail: undefined,
        }),
        emailOTP({
          allowedAttempts: OTP_ACCOUNT_BUDGET.max + 1,
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
      const response = await postAuth(auth, {
        path: "/sign-in/email-otp",
        body: { email: "account@example.test", otp: "654321" },
      });
      expect(response.status).toBe(400);
    }
    await postAuth(auth, {
      path: "/email-otp/send-verification-otp",
      body: { email: "account@example.test", type: "sign-in" },
    });
    expect(
      (
        await postAuth(auth, {
          path: "/sign-in/email-otp",
          body: { email: "account@example.test", otp: "123456" },
        })
      ).status,
    ).toBe(200);
  });
  test("counts unsuccessful verifications until the account window ends", async () => {
    const counter = createCounter();
    const budget = createOtpAccountBudget(counter.context, undefined);
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

  test("applies the configured account window", async () => {
    const budget = createOtpAccountBudget(
      createCounter().context,
      " Demo@Example.Test ",
    );
    for (let attempt = 0; attempt < DEMO_OTP_ACCOUNT_BUDGET.max; attempt += 1) {
      await reserveAllowed(
        budget,
        attempt % 2 === 0 ? "demo@example.test" : " DEMO@EXAMPLE.TEST ",
      );
    }
    expect(await budget.reserve("demo@example.test")).toMatchObject({
      status: "error",
      error: { statusCode: 429 },
    });
    for (let attempt = 0; attempt < OTP_ACCOUNT_BUDGET.max; attempt += 1) {
      await reserveAllowed(budget, "other@example.test");
    }
    expect(await budget.reserve("other@example.test")).toMatchObject({
      status: "error",
      error: { statusCode: 429 },
    });
  });

  test("successful verifications return their reservation", async () => {
    const budget = createOtpAccountBudget(createCounter().context, undefined);
    for (let attempt = 0; attempt < OTP_ACCOUNT_BUDGET.max * 2; attempt += 1) {
      await budget.complete(
        await reserveAllowed(budget, "account@example.test"),
        true,
      );
    }
  });

  test("bounds simultaneous account reservations", async () => {
    const budget = createOtpAccountBudget(createCounter().context, undefined);
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
            demoAccountEmail: undefined,
          }),
          emailOTP({
            allowedAttempts: OTP_ACCOUNT_BUDGET.max + 1,
            generateOTP: () => "123456",
            sendVerificationOTP: async () => undefined,
          }),
        ],
      });
      for (let attempt = 0; attempt <= OTP_ACCOUNT_BUDGET.max; attempt += 1) {
        await postAuth(auth, {
          path: "/email-otp/send-verification-otp",
          body: { email: "account@example.test", type: "sign-in" },
        });
        const response = await postAuth(auth, {
          path: "/sign-in/email-otp",
          body: {
            email: "account@example.test",
            otp: valid ? "123456" : "654321",
          },
        });
        const failureStatus = attempt < OTP_ACCOUNT_BUDGET.max ? 400 : 429;
        expect(response.status).toBe(valid ? 200 : failureStatus);
      }
    },
  );

  test("applies the configured window to OTP requests", async () => {
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
          demoAccountEmail: " ACCOUNT@EXAMPLE.TEST ",
        }),
        emailOTP({
          allowedAttempts: DEMO_OTP_ACCOUNT_BUDGET.max + 1,
          generateOTP: () => "123456",
          sendVerificationOTP: async () => undefined,
        }),
      ],
    });
    for (
      let attempt = 0;
      attempt <= DEMO_OTP_ACCOUNT_BUDGET.max;
      attempt += 1
    ) {
      await postAuth(auth, {
        path: "/email-otp/send-verification-otp",
        body: { email: "account@example.test", type: "sign-in" },
      });
      const response = await postAuth(auth, {
        path: "/sign-in/email-otp",
        body: { email: "account@example.test", otp: "654321" },
      });
      expect(response.status).toBe(
        attempt < DEMO_OTP_ACCOUNT_BUDGET.max ? 400 : 429,
      );
    }
  });

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
          demoAccountEmail: undefined,
        }),
        emailOTP({
          allowedAttempts: OTP_ACCOUNT_BUDGET.max + 1,
          changeEmail: { enabled: true },
          generateOTP: () => "123456",
          sendVerificationOTP: async () => undefined,
        }),
      ],
    });
    await postAuth(auth, {
      path: "/email-otp/send-verification-otp",
      body: { email: "account@example.test", type: "sign-in" },
    });
    const signedIn = await postAuth(auth, {
      path: "/sign-in/email-otp",
      body: { email: "account@example.test", otp: "123456" },
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";").at(0))
      .join("; ");
    expect(cookie).not.toBe("");
    for (let attempt = 0; attempt < OTP_ACCOUNT_BUDGET.max * 2; attempt += 1) {
      const response = await postAuth(auth, {
        path: "/email-otp/change-email",
        body: { newEmail: "updated@example.test", otp: "654321" },
        headers: { cookie },
      });
      expect(response.status).toBe(400);
    }
    for (let attempt = 0; attempt <= OTP_ACCOUNT_BUDGET.max; attempt += 1) {
      const newEmail = `updated-${attempt}@example.test`;
      await postAuth(auth, {
        path: "/email-otp/request-email-change",
        body: { newEmail },
        headers: { cookie },
      });
      const response = await postAuth(auth, {
        path: "/email-otp/change-email",
        body: { newEmail: newEmail.toUpperCase(), otp: "654321" },
        headers: { cookie },
      });
      expect(response.status).toBe(
        attempt < OTP_ACCOUNT_BUDGET.max ? 400 : 429,
      );
    }
    expect(
      (
        await postAuth(auth, {
          path: "/email-otp/change-email",
          body: {
            newEmail: `updated-${OTP_ACCOUNT_BUDGET.max}@example.test`,
            otp: "123456",
          },
          headers: { cookie },
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
          demoAccountEmail: undefined,
        }),
        emailOTP({
          allowedAttempts: OTP_ACCOUNT_BUDGET.max + 1,
          changeEmail: { enabled: true, verifyCurrentEmail: true },
          generateOTP: () => "123456",
          sendVerificationOTP: async () => undefined,
        }),
      ],
    });
    await postAuth(auth, {
      path: "/email-otp/send-verification-otp",
      body: { email: "account@example.test", type: "sign-in" },
    });
    const signedIn = await postAuth(auth, {
      path: "/sign-in/email-otp",
      body: { email: "account@example.test", otp: "123456" },
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";").at(0))
      .join("; ");
    for (let attempt = 0; attempt < OTP_ACCOUNT_BUDGET.max * 2; attempt += 1) {
      expect(
        (
          await postAuth(auth, {
            path: "/email-otp/request-email-change",
            body: { newEmail: "updated@example.test", otp: "654321" },
            headers: { cookie },
          })
        ).status,
      ).toBe(400);
    }
    for (let attempt = 0; attempt <= OTP_ACCOUNT_BUDGET.max; attempt += 1) {
      await postAuth(auth, {
        path: "/email-otp/send-verification-otp",
        body: { email: "account@example.test", type: "email-verification" },
      });
      expect(
        (
          await postAuth(auth, {
            path: "/email-otp/request-email-change",
            body: { newEmail: "updated@example.test", otp: "654321" },
            headers: { cookie },
          })
        ).status,
      ).toBe(attempt < OTP_ACCOUNT_BUDGET.max ? 400 : 429);
    }
    expect(
      (
        await postAuth(auth, {
          path: "/email-otp/request-email-change",
          body: { newEmail: "updated@example.test", otp: "123456" },
          headers: { cookie },
        })
      ).status,
    ).toBe(429);
  });
});

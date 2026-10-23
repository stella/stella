import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailOTP } from "better-auth/plugins";
import { expect, jest, setSystemTime, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import {
  getEmailOtpMinimumResponseDuration,
  getNewAccountEmailOtpAction,
  NEW_ACCOUNT_OTP_RATE_LIMIT_MODE,
  runEmailOtpRequestOnResponseSchedule,
} from "@/api/lib/auth";

const baseURL = "http://localhost:3001";
const email = "account@example.test";
const accountStates = ["unknown", "provider-unverified", "known"] as const;
const sendPath = "/email-otp/send-verification-otp";

const createScheduledAuth = async (
  accountState: (typeof accountStates)[number],
) => {
  const timerReady = Promise.withResolvers<undefined>();
  const deliveryReady = Promise.withResolvers<undefined>();
  const delivery = Promise.withResolvers<undefined>();
  const detached: Promise<void>[] = [];
  let action:
    | Awaited<ReturnType<typeof getNewAccountEmailOtpAction>>["type"]
    | undefined;
  let delivered = false;
  const delay = getEmailOtpMinimumResponseDuration({
    path: sendPath,
    runtimeMode: { mode: RUNTIME_MODE.strict },
    type: "sign-in",
  });
  const auth = betterAuth({
    baseURL,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    logger: { disabled: true },
    database: memoryAdapter({
      user: [],
      account: [],
      session: [],
      verification: [],
    }),
    plugins: [
      emailOTP({
        sendVerificationOTP: async ({ email: requestedEmail, type }, ctx) =>
          await runEmailOtpRequestOnResponseSchedule({
            responseDelayMs: getEmailOtpMinimumResponseDuration({
              path: ctx?.path,
              runtimeMode: { mode: RUNTIME_MODE.strict },
              type,
            }),
            detach: (operation) => {
              detached.push(operation);
            },
            wait: async (durationMs) => {
              const scheduled = sleep(durationMs);
              timerReady.resolve(undefined);
              await scheduled;
            },
            runRequest: async () => {
              const policy = await getNewAccountEmailOtpAction(
                {
                  body: { email: requestedEmail, type },
                  path: ctx?.path ?? "",
                },
                {
                  accountExists: async () => accountState !== "unknown",
                  rateLimitMode: NEW_ACCOUNT_OTP_RATE_LIMIT_MODE.enforced,
                  rateLimitContext: {
                    increment: async () => ({
                      count: 5,
                      start: Date.now(),
                      nextReset: new Date(Date.now() + 60_000),
                    }),
                  },
                },
              );
              action = policy.type;
              deliveryReady.resolve(undefined);
              if (policy.type === "suppress_otp") {
                return;
              }
              await delivery.promise;
              delivered = true;
            },
          }),
      }),
    ],
  });
  if (accountState !== "unknown") {
    const context = await auth.$context;
    await context.internalAdapter.createUser(
      { email, name: "Account", emailVerified: accountState === "known" },
      { method: "admin" },
    );
  }
  return {
    auth,
    delay,
    timerReady,
    deliveryReady,
    delivery,
    detached,
    getAction: () => action,
    isDelivered: () => delivered,
  };
};

test("email-code requests share response status, body and scheduled time for each account state", async () => {
  jest.useFakeTimers();
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  try {
    const fixtures = await Promise.all(accountStates.map(createScheduledAuth));
    const startedAt = Date.now();
    const completed: { status: number; body: unknown; elapsed: number }[] = [];
    const responses = fixtures.map(async ({ auth }) => {
      const response = await auth.api.sendVerificationOTP({
        body: { email, type: "sign-in" },
        asResponse: true,
      });
      completed.push({
        status: response.status,
        body: await response.json(),
        elapsed: Date.now() - startedAt,
      });
    });
    await Promise.all(
      fixtures.map(async ({ timerReady, deliveryReady }) => {
        await timerReady.promise;
        await deliveryReady.promise;
      }),
    );
    expect(fixtures.map((fixture) => fixture.getAction())).toEqual([
      "suppress_otp",
      "continue",
      "continue",
    ]);
    expect(completed).toHaveLength(0);
    const delay = fixtures.at(0)?.delay ?? 0;
    expect(delay).toBeGreaterThan(0);
    jest.advanceTimersByTime(delay - 1);
    await Promise.resolve(undefined);
    expect(completed).toHaveLength(0);
    jest.advanceTimersByTime(1);
    await Promise.all(responses);
    expect(completed).toEqual(
      Array.from({ length: 3 }, () => ({
        status: 200,
        body: { success: true },
        elapsed: delay,
      })),
    );
    expect(fixtures.map((fixture) => fixture.isDelivered())).toEqual([
      false,
      false,
      false,
    ]);
    for (const fixture of fixtures) {
      fixture.delivery.resolve(undefined);
    }
    await Promise.all(fixtures.flatMap((fixture) => fixture.detached));
    expect(fixtures.map((fixture) => fixture.isDelivered())).toEqual([
      false,
      true,
      true,
    ]);
  } finally {
    jest.useRealTimers();
    setSystemTime();
  }
});

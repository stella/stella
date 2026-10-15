import { betterAuth, type Verification } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  EMAIL_OTP_ALLOWED_ATTEMPTS,
  requireEmailOtpResetConfirmation,
} from "@/api/lib/auth/email-otp-reset-confirmation";

const email = "account@example.test";
const otp = "123456";
const identifier = `sign-in-otp-${email}`;

type FixtureOptions = {
  verified?: boolean;
  providers?: readonly string[];
  value?: string;
  expiresAt?: Date;
  olderValue?: string;
};

const createFixture = async ({
  verified = false,
  providers = ["microsoft"],
  value = `${otp}:0`,
  expiresAt = new Date(Date.now() + 60_000),
  olderValue,
}: FixtureOptions = {}) => {
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
      emailOTP({
        storeOTP: "plain",
        allowedAttempts: EMAIL_OTP_ALLOWED_ATTEMPTS,
        sendVerificationOTP: async () => {},
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const result = await requireEmailOtpResetConfirmation({
          path: ctx.path,
          body: ctx.body,
          internalAdapter: ctx.context.internalAdapter,
          adapter: ctx.context.adapter,
        });
        if (Result.isError(result)) {
          throw result.error;
        }
      }),
    },
  });
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser(
    { email, name: "Account", emailVerified: verified },
    { method: "email-otp" },
  );
  for (const providerId of providers) {
    await context.internalAdapter.createAccount({
      userId: user.id,
      providerId,
      accountId: `account-${providerId}`,
    });
  }
  const session = await context.internalAdapter.createSession(user.id);
  if (olderValue) {
    await context.internalAdapter.createVerificationValue({
      identifier,
      value: olderValue,
      expiresAt,
      createdAt: new Date(Date.now() - 60_000),
    });
  }
  await context.internalAdapter.createVerificationValue({
    identifier,
    value,
    expiresAt,
  });
  const signIn = async (body: {
    email: string;
    otp: string;
    confirmReset?: unknown;
  }) =>
    auth.handler(
      new Request("http://localhost:3001/api/auth/sign-in/email-otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  await context.internalAdapter.createVerificationValue({
    identifier: "sign-in-otp-other@example.test",
    value: "234567:0",
    expiresAt: new Date(Date.now() - 60_000),
  });
  const readState = async () => ({
    verification: await context.adapter.findOne<Verification>({
      model: "verification",
      where: [{ field: "identifier", value: identifier }],
    }),
    allVerifications: await context.adapter.findMany<Verification>({
      model: "verification",
    }),
    account: await context.internalAdapter.findUserByEmail(email, {
      includeAccounts: true,
    }),
    session: await context.internalAdapter.findSession(session.token),
  });
  return { signIn, readState };
};

describe("email code access reset confirmation", () => {
  test("checks the newest proof when older values share the identifier", async () => {
    const fixture = await createFixture({ olderValue: "654321:0" });
    const before = await fixture.readState();
    expect((await fixture.signIn({ email, otp })).status).toBe(409);
    expect(await fixture.readState()).toEqual(before);
  });
  test.each([undefined, false, "true"])(
    "valid proof asks for confirmation and preserves all state (%j)",
    async (confirmReset) => {
      const fixture = await createFixture({
        providers: ["microsoft", "google"],
      });
      const before = await fixture.readState();
      const response = await fixture.signIn({
        email: email.toUpperCase(),
        otp,
        confirmReset,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        code: "confirm_access_reset",
        message: "Confirm resetting account access to sign in with this code.",
        providers: ["microsoft", "google"],
      });
      expect(await fixture.readState()).toEqual(before);
    },
  );

  test("confirmation consumes proof, disconnects providers and signs out old sessions", async () => {
    const fixture = await createFixture();
    expect((await fixture.signIn({ email, otp })).status).toBe(409);
    const response = await fixture.signIn({ email, otp, confirmReset: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("session_token");
    const state = await fixture.readState();
    expect(state.verification).toBeNull();
    expect(state.account?.accounts).toEqual([]);
    expect(state.account?.user.emailVerified).toBe(true);
    expect(state.session).toBeNull();
    const replay = await fixture.signIn({ email, otp, confirmReset: true });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ code: "INVALID_OTP" });
  });

  test.each([undefined, false, true, "true"])(
    "invalid proof counts attempts without provider disclosure (%j)",
    async (confirmReset) => {
      const fixture = await createFixture();
      const before = await fixture.readState();
      const response = await fixture.signIn({
        email,
        otp: "654321",
        confirmReset,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_OTP" });
      const after = await fixture.readState();
      expect(after.verification?.value).toBe(`${otp}:1`);
      expect(after.account).toEqual(before.account);
      expect(after.session).toEqual(before.session);
    },
  );

  test.each([
    { verified: true, providers: ["microsoft"] },
    { verified: false, providers: [] },
  ])(
    "signs in without confirmation when no linked access needs resetting (%j)",
    async (options) => {
      const fixture = await createFixture(options);
      expect((await fixture.signIn({ email, otp })).status).toBe(200);
    },
  );

  test.each([
    {
      value: `${otp}:${EMAIL_OTP_ALLOWED_ATTEMPTS}`,
      code: "TOO_MANY_ATTEMPTS",
      status: 403,
    },
    {
      expiresAt: new Date(Date.now() - 60_000),
      code: "OTP_EXPIRED",
      status: 400,
    },
  ])(
    "delegates unavailable proof to the OTP endpoint (%j)",
    async ({ code, status, ...options }) => {
      const fixture = await createFixture(options);
      const before = await fixture.readState();
      const response = await fixture.signIn({ email, otp });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      const after = await fixture.readState();
      expect(after.account).toEqual(before.account);
      expect(after.session).toEqual(before.session);
    },
  );
});

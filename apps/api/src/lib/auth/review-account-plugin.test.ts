import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { organization, twoFactor } from "better-auth/plugins";
import { describe, expect, test } from "bun:test";

import { resolveEmailAndPasswordOptions } from "@/api/lib/auth/password-sign-in-options";
import {
  createReviewAccountPlugin,
  REVIEW_ACCOUNT_SIGN_IN_BUDGET,
} from "@/api/lib/auth/review-account-plugin";
import { createAccountAttemptBudget } from "@/api/lib/rate-limit/otp-account-budget";
import { RedisRateLimitContext } from "@/api/lib/rate-limit/redis-context";

const reviewEmail = "review@example.test";
const otherEmail = "member@example.test";
const reviewOrganizationId = "org_review";
const password = "fixture password for tests";
const config = { email: reviewEmail, organizationId: reviewOrganizationId };

const createLocalBudget = () => {
  const context = new RedisRateLimitContext({
    failurePolicy: "fail_open_local",
    createRedis: () => ({
      send: async () => {
        throw new TypeError("Counter unavailable");
      },
    }),
    onRedisError: () => undefined,
  });
  context.init({ duration: REVIEW_ACCOUNT_SIGN_IN_BUDGET.durationMs });
  return createAccountAttemptBudget(context, {
    counterPrefix: "password-account",
    budgetFor: () => REVIEW_ACCOUNT_SIGN_IN_BUDGET,
  });
};

const createReviewAuth = async ({
  activeOrganizationId = reviewOrganizationId,
  localPasswordEnabled = false,
}: {
  activeOrganizationId?: string;
  localPasswordEnabled?: boolean;
} = {}) => {
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      twoFactor: [],
      organization: [],
      member: [],
      invitation: [],
      team: [],
      teamMember: [],
      organizationRole: [],
    }),
    emailAndPassword: resolveEmailAndPasswordOptions({
      localPasswordEnabled,
      reviewAccountConfigured: true,
    }),
    session: {
      additionalFields: {
        activeOrganizationId: { type: "string", required: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => ({
            data: { ...session, activeOrganizationId },
          }),
        },
      },
    },
    plugins: [
      createReviewAccountPlugin({
        config,
        localPasswordEnabled,
        signInBudget: createLocalBudget(),
      }),
      twoFactor({ allowPasswordless: true }),
      organization({ allowUserToCreateOrganization: true }),
    ],
  });
  // Accounts are provisioned out of band; sign-up is off.
  const context = await auth.$context;
  for (const email of [reviewEmail, otherEmail]) {
    const user = await context.internalAdapter.createUser(
      { email, name: "Fixture", emailVerified: true },
      { method: "admin" },
    );
    await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: await context.password.hash(password),
    });
  }
  return auth;
};

const postAuth = async (
  auth: { handler: (request: Request) => Promise<Response> },
  path: string,
  body: Record<string, unknown>,
  cookie?: string,
) =>
  await auth.handler(
    new Request(`http://localhost:3001/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3001",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    }),
  );

const sessionCookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";").at(0))
    .join("; ");

const answer = async (response: Response) => ({
  status: response.status,
  body: await response.json(),
});

describe("restricted review account password sign-in", () => {
  test("signs the review account in with its password", async () => {
    const auth = await createReviewAuth();
    const response = await postAuth(auth, "/sign-in/email", {
      email: "Review@Example.Test",
      password,
    });
    expect(response.status).toBe(200);
    const session = await auth.api.getSession({
      headers: { cookie: sessionCookie(response) },
    });
    expect(session?.user.email).toBe(reviewEmail);
    expect(session?.session["activeOrganizationId"]).toBe(reviewOrganizationId);
  });

  test("answers every other address exactly as a wrong password", async () => {
    const auth = await createReviewAuth();
    const wrongPassword = await answer(
      await postAuth(auth, "/sign-in/email", {
        email: reviewEmail,
        password: "not the fixture password",
      }),
    );
    expect(wrongPassword.status).toBe(401);
    // An account that holds a matching password, and an unknown address.
    for (const email of [otherEmail, "unknown@example.test"]) {
      for (const candidate of [password, "not the fixture password"]) {
        expect(
          await answer(
            await postAuth(auth, "/sign-in/email", {
              email,
              password: candidate,
            }),
          ),
        ).toEqual(wrongPassword);
      }
    }
  });

  test("keeps local password sign-in open to every account when it is enabled", async () => {
    const auth = await createReviewAuth({ localPasswordEnabled: true });
    const response = await postAuth(auth, "/sign-in/email", {
      email: otherEmail,
      password,
    });
    expect(response.status).toBe(200);
  });

  test("refuses sign-up for the review address and every other one", async () => {
    const auth = await createReviewAuth();
    for (const email of [reviewEmail, "new@example.test"]) {
      const response = await postAuth(auth, "/sign-up/email", {
        email,
        name: "Fixture",
        password,
      });
      expect(response.ok).toBe(false);
    }
    const context = await auth.$context;
    expect(
      await context.internalAdapter.findUserByEmail("new@example.test"),
    ).toBeNull();
  });

  test("locks the account after the failure budget, even for the right password", async () => {
    const auth = await createReviewAuth();
    for (
      let attempt = 0;
      attempt < REVIEW_ACCOUNT_SIGN_IN_BUDGET.max;
      attempt += 1
    ) {
      const response = await postAuth(auth, "/sign-in/email", {
        email: reviewEmail,
        password: "not the fixture password",
      });
      expect(response.status).toBe(401);
    }
    const locked = await postAuth(auth, "/sign-in/email", {
      email: reviewEmail,
      password,
    });
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({
      code: "account_sign_in_limited",
    });
  });

  test("refuses account, organization and second-factor changes", async () => {
    const auth = await createReviewAuth();
    const cookie = sessionCookie(
      await postAuth(auth, "/sign-in/email", { email: reviewEmail, password }),
    );
    for (const [path, body] of [
      ["/organization/create", { name: "Another", slug: "another" }],
      [
        "/organization/invite-member",
        { email: "guest@example.test", role: "member" },
      ],
      [
        "/change-password",
        { currentPassword: password, newPassword: password },
      ],
      ["/change-email", { newEmail: "moved@example.test" }],
      ["/two-factor/enable", {}],
      ["/delete-user", {}],
    ] as const) {
      const response = await postAuth(auth, path, body, cookie);
      expect({ path, status: response.status }).toEqual({ path, status: 403 });
    }
    const recovery = await postAuth(auth, "/request-password-reset", {
      email: reviewEmail,
    });
    expect(recovery.status).toBe(403);
  });

  test("does not resolve a review session outside its organization", async () => {
    const auth = await createReviewAuth({ activeOrganizationId: "org_other" });
    const response = await postAuth(auth, "/sign-in/email", {
      email: reviewEmail,
      password,
    });
    const cookie = sessionCookie(response);
    expect(await auth.api.getSession({ headers: { cookie } })).toBeNull();
    const refused = await postAuth(
      auth,
      "/organization/set-active",
      { organizationId: reviewOrganizationId },
      cookie,
    );
    expect(refused.status).toBe(403);
  });

  test("refuses a reset token issued before the account was restricted", async () => {
    const auth = await createReviewAuth();
    const context = await auth.$context;
    const account = await context.internalAdapter.findUserByEmail(reviewEmail);
    expect(account).not.toBeNull();
    // A token issued earlier, as the reset email flow stores it.
    await context.internalAdapter.createVerificationValue({
      identifier: "reset-password:fixture-token",
      value: account?.user.id ?? "",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    for (const request of [
      {
        body: { token: "fixture-token", newPassword: "a new fixture password" },
      },
      {
        body: { newPassword: "a new fixture password" },
        query: "fixture-token",
      },
    ]) {
      const response = await auth.handler(
        new Request(
          `http://localhost:3001/api/auth/reset-password${
            request.query === undefined ? "" : `?token=${request.query}`
          }`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "http://localhost:3001",
            },
            body: JSON.stringify(request.body),
          },
        ),
      );
      expect(response.status).toBe(403);
    }
    expect(
      (
        await postAuth(auth, "/sign-in/email", {
          email: reviewEmail,
          password: "a new fixture password",
        })
      ).status,
    ).toBe(401);
    expect(
      (await postAuth(auth, "/sign-in/email", { email: reviewEmail, password }))
        .status,
    ).toBe(200);
  });
});

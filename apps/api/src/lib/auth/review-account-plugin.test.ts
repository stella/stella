import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailOTP, organization, twoFactor } from "better-auth/plugins";
import { describe, expect, test } from "bun:test";
import { SignJWT } from "jose";

import { resolveEmailAndPasswordOptions } from "@/api/lib/auth/password-sign-in-options";
import {
  createReviewAccountPlugin,
  REVIEW_ACCOUNT_SIGN_IN_BUDGET,
} from "@/api/lib/auth/review-account-plugin";
import {
  isReviewAccountBodyEmailPath,
  isReviewAccountTargetCheckedPath,
  resolveReviewAccountSessionOperation,
} from "@/api/lib/auth/review-account-policy";
import {
  findReviewAccountTokenRedemption,
  isReviewAccountTokenRedemptionPath,
  matchesAuthPathTemplate,
  REVIEW_ACCOUNT_TOKEN_REDEMPTIONS,
} from "@/api/lib/auth/review-account-token-subjects";
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
    // A configured social provider, so its callback reaches the hooks.
    socialProviders: {
      google: {
        clientId: "fixture-client-id",
        clientSecret: "fixture-client-secret",
      },
    },
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
      emailOTP({ sendVerificationOTP: async () => undefined }),
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

/**
 * Endpoints the restricted review account may call: reads, its own session
 * and credential lifecycle, and sign-in. Reviewed; anything that changes
 * identity, credentials, membership or second factors is mapped to a refused
 * operation instead.
 */
const REVIEWED_OPEN_AUTH_PATHS: ReadonlySet<string> = new Set([
  // Reads.
  "/account-info",
  "/get-session",
  "/list-accounts",
  "/list-sessions",
  "/ok",
  "/error",
  // Sign-in and the account's own sessions.
  "/sign-in/email",
  "/sign-in/social",
  "/sign-out",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/update-session",
  // Provider tokens of identities already linked; linking itself is refused.
  "/get-access-token",
  "/refresh-token",
  // Profile fields only; email changes go through the refused endpoints.
  "/update-user",
  "/verify-password",
  // Sends a verification link; redeeming it is a checked token redemption.
  "/send-verification-email",
  // The reset form's redirect only; completing a reset is a token
  // redemption, checked by its subject.
  "/reset-password/:token",
]);

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

  test("never locks the account for successful sign-ins", async () => {
    const auth = await createReviewAuth();
    // Through the real handler: each success must give its slot back.
    for (
      let attempt = 0;
      attempt < REVIEW_ACCOUNT_SIGN_IN_BUDGET.max * 2 + 1;
      attempt += 1
    ) {
      const response = await postAuth(auth, "/sign-in/email", {
        email: reviewEmail,
        password,
      });
      expect({ attempt, status: response.status }).toEqual({
        attempt,
        status: 200,
      });
    }
    // Failures in the same window still count towards the lock.
    for (
      let attempt = 0;
      attempt < REVIEW_ACCOUNT_SIGN_IN_BUDGET.max;
      attempt += 1
    ) {
      expect(
        (
          await postAuth(auth, "/sign-in/email", {
            email: reviewEmail,
            password: "not the fixture password",
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (await postAuth(auth, "/sign-in/email", { email: reviewEmail, password }))
        .status,
    ).toBe(429);
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

  test("refuses unlinking an identity, so password sign-in cannot be removed", async () => {
    const auth = await createReviewAuth();
    const context = await auth.$context;
    const userId =
      (await context.internalAdapter.findUserByEmail(reviewEmail))?.user.id ??
      "";
    // The provisioned credential plus a social identity.
    await context.internalAdapter.linkAccount({
      userId,
      providerId: "google",
      accountId: "google-fixture-subject",
    });
    const cookie = sessionCookie(
      await postAuth(auth, "/sign-in/email", { email: reviewEmail, password }),
    );
    for (const providerId of ["credential", "google"]) {
      const response = await postAuth(
        auth,
        "/unlink-account",
        { providerId },
        cookie,
      );
      expect({ providerId, status: response.status }).toEqual({
        providerId,
        status: 403,
      });
    }
    expect(
      (await context.internalAdapter.findAccounts(userId))
        .map((account) => account.providerId)
        .toSorted(),
    ).toEqual(["credential", "google"]);
  });

  test("classifies every auth endpoint the router exposes", async () => {
    const auth = await createReviewAuth();
    const isPostLike = (method: unknown) =>
      (Array.isArray(method) ? method : [method]).some(
        (entry) => entry !== "GET",
      );
    const unclassified = Object.values(auth.api)
      .flatMap((endpoint: unknown) => {
        const path: unknown =
          typeof endpoint === "function" ? Reflect.get(endpoint, "path") : null;
        const options: unknown =
          typeof endpoint === "function"
            ? Reflect.get(endpoint, "options")
            : null;
        const method =
          typeof options === "object" && options !== null
            ? Reflect.get(options, "method")
            : undefined;
        if (typeof path !== "string") {
          return [];
        }
        const operation = resolveReviewAccountSessionOperation({
          path,
          method: isPostLike(method) ? "POST" : "GET",
        });
        return operation === null &&
          !isReviewAccountBodyEmailPath(path) &&
          !isReviewAccountTokenRedemptionPath(path) &&
          !isReviewAccountTargetCheckedPath(path) &&
          !REVIEWED_OPEN_AUTH_PATHS.has(path)
          ? [path]
          : [];
      })
      .toSorted();
    // A new endpoint lands here until it is mapped to an operation or
    // reviewed as open for the restricted review account.
    expect(unclassified).toEqual([]);
  });

  test("marks every token-redeeming endpoint and checks its subject", async () => {
    const auth = await createReviewAuth();
    const routerPaths = new Set(
      Object.values(auth.api).flatMap((endpoint: unknown) => {
        const path: unknown =
          typeof endpoint === "function" ? Reflect.get(endpoint, "path") : null;
        return typeof path === "string" ? [path] : [];
      }),
    );
    const redemptions = Object.keys(
      REVIEW_ACCOUNT_TOKEN_REDEMPTIONS,
    ).toSorted();
    expect(redemptions).toEqual([
      "/callback/:id",
      "/delete-user/callback",
      "/reset-password",
      "/verify-email",
    ]);
    // A concrete request path for every template.
    const concreteExamples: Readonly<Record<string, string>> = {
      "/callback/:id": "/callback/google",
    };
    for (const path of redemptions) {
      expect({ path, routed: routerPaths.has(path) }).toEqual({
        path,
        routed: true,
      });
      expect(REVIEWED_OPEN_AUTH_PATHS.has(path)).toBe(false);
      const concrete = path.includes(":") ? concreteExamples[path] : path;
      expect({ path, concrete }).toEqual({
        path,
        concrete: expect.any(String),
      });
      expect(findReviewAccountTokenRedemption(concrete ?? "")).toBe(
        REVIEW_ACCOUNT_TOKEN_REDEMPTIONS[path],
      );
    }
    expect(matchesAuthPathTemplate("/callback/:id", "/callback/")).toBe(false);
    expect(
      matchesAuthPathTemplate("/callback/:id", "/callback/google/extra"),
    ).toBe(false);
    expect(isReviewAccountTokenRedemptionPath("/callback")).toBe(false);
  });

  test("refuses an email-change link issued before the account was restricted", async () => {
    const auth = await createReviewAuth();
    const context = await auth.$context;
    // A change-email confirmation link, signed as Better Auth signs it.
    const token = await new SignJWT({
      email: reviewEmail,
      updateTo: "moved@example.test",
      requestType: "change-email-verification",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(context.secret));
    const response = await auth.handler(
      new Request(
        `http://localhost:3001/api/auth/verify-email?token=${token}`,
        { headers: { origin: "http://localhost:3001" } },
      ),
    );
    expect(response.status).toBe(403);
    expect(
      await context.internalAdapter.findUserByEmail(reviewEmail),
    ).not.toBeNull();
    expect(
      await context.internalAdapter.findUserByEmail("moved@example.test"),
    ).toBeNull();
  });

  test("refuses stored deletion and identity-link tokens for the account", async () => {
    const auth = await createReviewAuth();
    const context = await auth.$context;
    const userId =
      (await context.internalAdapter.findUserByEmail(reviewEmail))?.user.id ??
      "";
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await context.internalAdapter.createVerificationValue({
      identifier: "delete-account-fixture-token",
      value: userId,
      expiresAt,
    });
    await context.internalAdapter.createVerificationValue({
      identifier: "fixture-state",
      value: JSON.stringify({
        callbackURL: "/",
        codeVerifier: "fixture-verifier",
        expiresAt: expiresAt.getTime(),
        link: { email: reviewEmail, userId },
      }),
      expiresAt,
    });
    for (const path of [
      "/delete-user/callback?token=fixture-token",
      "/callback/google?state=fixture-state&code=fixture-code",
    ]) {
      const response = await auth.handler(
        new Request(`http://localhost:3001/api/auth${path}`, {
          headers: { origin: "http://localhost:3001" },
        }),
      );
      // Refused by the account policy, not by a missing provider or token.
      expect({
        path,
        status: response.status,
        body: await response.json(),
      }).toMatchObject({
        path,
        status: 403,
        body: { code: "account_access_unavailable" },
      });
    }
    expect(await context.internalAdapter.findUserById(userId)).not.toBeNull();
    // A callback whose state links no restricted account is not refused here.
    const ordinary = await auth.handler(
      new Request(
        "http://localhost:3001/api/auth/callback/google?state=unknown-state&code=fixture-code",
        { headers: { origin: "http://localhost:3001" } },
      ),
    );
    expect(ordinary.status).not.toBe(403);
  });

  test("checks the organization a request names, not only the session's", async () => {
    const auth = await createReviewAuth();
    const context = await auth.$context;
    const userId =
      (await context.internalAdapter.findUserByEmail(reviewEmail))?.user.id ??
      "";
    // The review organization and, for this test, a second membership.
    for (const organizationId of [reviewOrganizationId, "org_other"]) {
      await context.adapter.create({
        model: "organization",
        data: {
          id: organizationId,
          name: organizationId,
          slug: organizationId,
          createdAt: new Date(),
        },
        forceAllowId: true,
      });
      await context.adapter.create({
        model: "member",
        data: {
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
    }
    const cookie = sessionCookie(
      await postAuth(auth, "/sign-in/email", { email: reviewEmail, password }),
    );
    for (const body of [
      { organizationId: "org_other" },
      { organizationSlug: "org_other" },
      { organizationId: null },
    ]) {
      const response = await postAuth(
        auth,
        "/organization/set-active",
        body,
        cookie,
      );
      expect({ body, status: response.status }).toEqual({ body, status: 403 });
    }
    const own = await postAuth(
      auth,
      "/organization/set-active",
      { organizationId: reviewOrganizationId },
      cookie,
    );
    expect(own.status).toBe(200);
    const read = await auth.handler(
      new Request(
        "http://localhost:3001/api/auth/organization/get-full-organization?organizationId=org_other",
        { headers: { cookie, origin: "http://localhost:3001" } },
      ),
    );
    expect(read.status).toBe(403);
  });
});

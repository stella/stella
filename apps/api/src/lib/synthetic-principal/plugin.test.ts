import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import type { BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthEndpoint } from "better-auth/api";
import { makeSignature } from "better-auth/crypto";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { emailOTP, organization, twoFactor } from "better-auth/plugins";
import { expect, test } from "bun:test";

import { resolveEmailAndPasswordOptions } from "@/api/lib/auth/password-sign-in-options";
import { createReviewAccountPlugin } from "@/api/lib/auth/review-account-plugin";
import type { ReviewAccountOperation } from "@/api/lib/auth/review-account-policy";
import { createSyntheticPrincipalAuthHooks } from "@/api/lib/synthetic-principal/auth-hooks";
import { SYNTHETIC_PRINCIPAL } from "@/api/lib/synthetic-principal/constants";
import type { SYNTHETIC_PRINCIPAL_POLICY } from "@/api/lib/synthetic-principal/policy";
import {
  checkSyntheticPrincipalAccess,
  syntheticPrincipalAuthConfig,
} from "@/api/lib/synthetic-principal/policy";

type RefusedOperation = {
  [
    Operation in ReviewAccountOperation
  ]: (typeof SYNTHETIC_PRINCIPAL_POLICY)[Operation] extends "refused"
    ? Operation
    : never;
}[ReviewAccountOperation];

type AuthRequestCase = {
  body: Record<string, unknown>;
  path: string;
  requiresSession: boolean;
};

const REFUSED_AUTH_REQUESTS = {
  mcp: [
    { path: "/oauth2/consent", body: { accept: true }, requiresSession: true },
  ],
  "password-sign-in": [
    {
      path: "/sign-in/email",
      body: { email: SYNTHETIC_PRINCIPAL.user.email, password: "fixture" },
      requiresSession: false,
    },
  ],
  "email-code-sign-in": [
    {
      path: "/email-otp/send-verification-otp",
      body: { email: SYNTHETIC_PRINCIPAL.user.email, type: "sign-in" },
      requiresSession: false,
    },
    {
      path: "/sign-in/email-otp",
      body: { email: SYNTHETIC_PRINCIPAL.user.email, otp: "000000" },
      requiresSession: false,
    },
  ],
  "verify-email": [
    {
      path: "/email-otp/verify-email",
      body: { email: SYNTHETIC_PRINCIPAL.user.email, otp: "000000" },
      requiresSession: false,
    },
  ],
  "create-organization": [
    {
      path: "/organization/create",
      body: { name: "Another", slug: "another" },
      requiresSession: true,
    },
  ],
  "manage-organization": [
    {
      path: "/organization/update",
      body: { organizationId: SYNTHETIC_PRINCIPAL.org.id, name: "Updated" },
      requiresSession: true,
    },
  ],
  "send-invitation": [
    {
      path: "/organization/invite-member",
      body: {
        email: "member@example.test",
        organizationId: SYNTHETIC_PRINCIPAL.org.id,
        role: "member",
      },
      requiresSession: true,
    },
  ],
  "accept-invitation": [
    {
      path: "/organization/accept-invitation",
      body: { invitationId: "fixture-invitation" },
      requiresSession: true,
    },
  ],
  "change-email": [
    {
      path: "/change-email",
      body: { newEmail: "moved@example.test" },
      requiresSession: true,
    },
  ],
  "change-password": [
    {
      path: "/change-password",
      body: { currentPassword: "fixture", newPassword: "another fixture" },
      requiresSession: true,
    },
  ],
  "enroll-two-factor": [
    { path: "/two-factor/enable", body: {}, requiresSession: true },
  ],
  "create-api-key": [
    {
      path: "/api-key/create",
      body: { userId: SYNTHETIC_PRINCIPAL.user.id, name: "Fixture" },
      requiresSession: true,
    },
  ],
  "link-identity": [
    {
      path: "/link-social",
      body: { provider: "google" },
      requiresSession: true,
    },
  ],
  "delete-account": [{ path: "/delete-user", body: {}, requiresSession: true }],
  // These dispositions are exercised through the shared access check in
  // policy.test.ts; neither has a dedicated Better Auth endpoint.
  "join-organization": null,
  "account-control-operation": null,
} as const satisfies Record<
  RefusedOperation,
  readonly AuthRequestCase[] | null
>;

const socialSignInFixturePlugin = {
  id: "synthetic-social-sign-in-fixture",
  endpoints: {
    socialSignInFixture: createAuthEndpoint(
      "/fixture/social-sign-in",
      { method: "POST" },
      async (ctx) => {
        const body: unknown = ctx.body;
        const email =
          typeof body === "object" && body !== null
            ? Reflect.get(body, "email")
            : undefined;
        const result = await handleOAuthUserInfo(ctx, {
          userInfo: {
            id: "google-fixture-subject",
            email: typeof email === "string" ? email : "",
            emailVerified: true,
            name: "Fixture",
            image: null,
          },
          account: {
            providerId: "google",
            accountId: "google-fixture-subject",
          },
          callbackURL: "/",
        });
        return ctx.json({ error: result.error ?? null });
      },
    ),
  },
} satisfies BetterAuthPlugin;

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

const createSyntheticAuth = async ({
  provisioned = true,
}: {
  provisioned?: boolean;
} = {}) => {
  let emailCallbacks = 0;
  const hooks = createSyntheticPrincipalAuthHooks();
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
      apikey: [],
      oauthClient: [],
      oauthAccessToken: [],
      oauthRefreshToken: [],
      oauthConsent: [],
      oauthResource: [],
      oauthClientResource: [],
    }),
    emailAndPassword: resolveEmailAndPasswordOptions({
      localPasswordEnabled: true,
      reviewAccountConfigured: true,
    }),
    session: {
      additionalFields: {
        activeOrganizationId: { type: "string", required: false },
      },
    },
    socialProviders: {
      google: {
        clientId: "fixture-client-id",
        clientSecret: "fixture-client-secret",
      },
    },
    databaseHooks: {
      account: {
        create: {
          before: async (account) => {
            hooks.accountCreateBefore(account);
            await Promise.resolve();
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            hooks.userCreateBefore(user);
            await Promise.resolve();
          },
        },
      },
    },
    plugins: [
      createReviewAccountPlugin({
        id: "restricted-monitoring-account-test",
        config: syntheticPrincipalAuthConfig,
        checkAccess: checkSyntheticPrincipalAccess,
        localPasswordEnabled: true,
      }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        disableJwtPlugin: true,
        resourceSeedMode: "none",
        scopes: ["offline_access", "read"],
      }),
      apiKey(),
      emailOTP({
        sendVerificationOTP: async () => {
          emailCallbacks += 1;
        },
      }),
      organization({ allowUserToCreateOrganization: true }),
      twoFactor({ allowPasswordless: true }),
      socialSignInFixturePlugin,
    ],
  });
  const context = await auth.$context;
  let cookie: string | undefined;
  if (provisioned) {
    // Fixture rows are pre-existing; database hooks cover request writes.
    await context.adapter.create({
      model: "user",
      data: {
        id: SYNTHETIC_PRINCIPAL.user.id,
        email: SYNTHETIC_PRINCIPAL.user.email,
        name: SYNTHETIC_PRINCIPAL.user.name,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      forceAllowId: true,
    });
    const session = await context.internalAdapter.createSession(
      SYNTHETIC_PRINCIPAL.user.id,
    );
    await context.adapter.update({
      model: "session",
      where: [{ field: "id", value: session.id }],
      update: { activeOrganizationId: SYNTHETIC_PRINCIPAL.org.id },
    });
    const signedToken = `${session.token}.${await makeSignature(
      session.token,
      context.secret,
    )}`;
    cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(
      signedToken,
    )}`;
  }
  return {
    auth,
    cookie,
    context,
    emailCallbacks: () => emailCallbacks,
  };
};

test("refuses each classified auth operation through Better Auth", async () => {
  const { auth, cookie } = await createSyntheticAuth();
  const paths = new Set(
    Object.values(auth.api).flatMap((endpoint: unknown) => {
      const path: unknown =
        typeof endpoint === "function" ? Reflect.get(endpoint, "path") : null;
      return typeof path === "string" ? [path] : [];
    }),
  );

  for (const requests of Object.values(REFUSED_AUTH_REQUESTS)) {
    if (requests === null) {
      continue;
    }
    for (const { body, path, requiresSession } of requests) {
      expect({ path, registered: paths.has(path) }).toEqual({
        path,
        registered: true,
      });
      const response = await postAuth(
        auth,
        path,
        body,
        requiresSession ? cookie : undefined,
      );
      expect({ path, status: response.status }).toEqual({ path, status: 403 });
      expect(await response.json()).toMatchObject({
        code: "account_access_unavailable",
      });
    }
  }
});

test("resolves only its own session and refuses another organization", async () => {
  const { auth, cookie } = await createSyntheticAuth();
  const ownSession = await auth.api.getSession({
    headers: { cookie: cookie ?? "" },
  });
  expect(ownSession?.user.id).toBe(SYNTHETIC_PRINCIPAL.user.id);
  if (!ownSession || !("activeOrganizationId" in ownSession.session)) {
    throw new Error("Synthetic session has no active organization");
  }
  expect(ownSession.session.activeOrganizationId).toBe(
    SYNTHETIC_PRINCIPAL.org.id,
  );

  const refused = await postAuth(
    auth,
    "/organization/set-active",
    { organizationId: "org_other" },
    cookie,
  );
  expect(refused.status).toBe(403);
});

test("does not send an email code for a synthetic sign-in", async () => {
  const { auth, emailCallbacks } = await createSyntheticAuth();
  const response = await postAuth(auth, "/email-otp/send-verification-otp", {
    email: SYNTHETIC_PRINCIPAL.user.email,
    type: "sign-in",
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "account_access_unavailable",
  });
  expect(emailCallbacks()).toBe(0);
});

test("refuses identity linking and account creation in OAuth callbacks", async () => {
  const linked = await createSyntheticAuth();
  const linkResponse = await postAuth(linked.auth, "/fixture/social-sign-in", {
    email: SYNTHETIC_PRINCIPAL.user.email,
  });
  expect(linkResponse.status).toBe(403);
  expect(await linkResponse.json()).toMatchObject({
    code: "account_access_unavailable",
  });
  expect(
    await linked.context.internalAdapter.findUserById(
      SYNTHETIC_PRINCIPAL.user.id,
    ),
  ).not.toBeNull();
  expect(
    await linked.context.internalAdapter.findAccounts(
      SYNTHETIC_PRINCIPAL.user.id,
    ),
  ).toEqual([]);

  const created = await createSyntheticAuth({ provisioned: false });
  const createResponse = await postAuth(
    created.auth,
    "/fixture/social-sign-in",
    { email: SYNTHETIC_PRINCIPAL.user.email },
  );
  expect(createResponse.status).toBe(403);
  expect(await createResponse.json()).toMatchObject({
    code: "account_access_unavailable",
  });
  expect(
    await created.context.internalAdapter.findUserByEmail(
      SYNTHETIC_PRINCIPAL.user.email,
    ),
  ).toBeNull();
});

test("refuses OAuth authorization from a monitoring session", async () => {
  const { auth, cookie } = await createSyntheticAuth();
  const query = new URLSearchParams({
    client_id: "fixture-client",
    response_type: "code",
    redirect_uri: "https://client.example.test/callback",
    scope: "offline_access read",
    code_challenge: "fixture-challenge",
    code_challenge_method: "S256",
  });
  const response = await auth.handler(
    new Request(
      `http://localhost:3001/api/auth/oauth2/authorize?${query.toString()}`,
      {
        headers: { cookie: cookie ?? "" },
      },
    ),
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "account_access_unavailable",
  });
});

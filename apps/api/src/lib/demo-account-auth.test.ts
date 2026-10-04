import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { organization, twoFactor } from "better-auth/plugins";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createDemoAuthSessionGuard } from "@/api/lib/auth/demo-account-hooks";
import { createDemoSessionFilter } from "@/api/lib/auth/demo-account-policy";

const organizationId = "org_account";
const email = "account@example.test";

type CreateAccountOptions = {
  accountEmail: string;
  binding: string | undefined;
  activeOrganizationId: string | undefined;
};

const createAccount = async ({
  accountEmail,
  binding,
  activeOrganizationId,
}: CreateAccountOptions) => {
  const config = { email, organizationId: binding };
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
      oauthClientResource: [],
      oauthResource: [],
      oauthConsent: [],
      oauthAccessToken: [],
      oauthRefreshToken: [],
    }),
    emailAndPassword: { enabled: true },
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
    hooks: { before: createDemoAuthSessionGuard(config) },
    plugins: [
      createDemoSessionFilter(config),
      twoFactor(),
      organization({
        allowUserToCreateOrganization: true,
        requireEmailVerificationOnInvitation: false,
      }),
      apiKey(),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        disableJwtPlugin: true,
        resourceSeedMode: "none",
        allowDynamicClientRegistration: true,
      }),
    ],
  });
  const signedIn = await auth.api.signUpEmail({
    body: {
      email: accountEmail,
      name: "Account",
      password: "A secure password 123!",
    },
    returnHeaders: true,
  });
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(";").at(0))
    .join("; ");
  return { auth, headers: { cookie }, userId: signedIn.response.user.id };
};

type PostAuthOptions = {
  auth: { handler: (request: Request) => Promise<Response> };
  headers: { cookie: string };
  path: string;
  body: Record<string, unknown>;
};

const postAuth = async ({ auth, headers, path, body }: PostAuthOptions) =>
  auth.handler(
    new Request(`http://localhost:3001/api/auth${path}`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        origin: "http://localhost:3001",
      },
      body: JSON.stringify(body),
    }),
  );

describe("account authentication operations", () => {
  test.each([undefined, organizationId])(
    "allows credential cleanup with each binding: %s",
    async (binding) => {
      for (const path of [
        "/sign-out",
        "/revoke-session",
        "/revoke-sessions",
        "/revoke-other-sessions",
      ]) {
        const { auth, headers, userId } = await createAccount({
          accountEmail: email,
          binding,
          activeOrganizationId: "org_other",
        });
        expect((await auth.api.getSession({ headers })) !== null).toBe(
          binding === undefined,
        );
        const context = await auth.$context;
        const sessions = await context.internalAdapter.listSessions(userId);
        const session = sessions.at(0);
        expect(session).toBeDefined();
        if (!session) {
          throw new Error("Session is required");
        }
        const response = await auth.handler(
          new Request(`http://localhost:3001/api/auth${path}`, {
            method: "POST",
            headers: {
              ...headers,
              "content-type": "application/json",
              origin: "http://localhost:3001",
            },
            body: JSON.stringify(
              path === "/revoke-session" ? { token: session.token } : {},
            ),
          }),
        );
        expect(response.status).toBe(200);
        if (path !== "/revoke-other-sessions") {
          expect(
            await context.internalAdapter.findSession(session.token),
          ).toBeNull();
        }
        if (path === "/sign-out") {
          expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
        }
      }
    },
  );

  test.each([email, "standard@example.test"])(
    "checks eligibility before two-factor changes: %s",
    async (accountEmail) => {
      for (const binding of [undefined, organizationId]) {
        for (const path of [
          "/two-factor/enable",
          "/two-factor/disable",
          "/two-factor/get-totp-uri",
          "/two-factor/verify-totp",
        ]) {
          const { auth, headers } = await createAccount({
            accountEmail,
            binding,
            activeOrganizationId: organizationId,
          });
          const response = await auth.handler(
            new Request(`http://localhost:3001/api/auth${path}`, {
              method: "POST",
              headers: {
                ...headers,
                "content-type": "application/json",
                origin: "http://localhost:3001",
              },
              body: JSON.stringify({
                password: "A secure password 123!",
                code: "123456",
              }),
            }),
          );
          if (accountEmail === email) {
            expect(response.status).toBe(403);
            expect(await response.json()).toMatchObject({
              code: "account_access_unavailable",
            });
          } else {
            expect(await response.json()).not.toMatchObject({
              code: "account_access_unavailable",
            });
          }
        }
      }
    },
  );

  test.each([undefined, organizationId])(
    "limits organization and key changes with binding %s",
    async (binding) => {
      const demo = await createAccount({
        accountEmail: email,
        binding,
        activeOrganizationId: binding,
      });
      const standard = await createAccount({
        accountEmail: "standard@example.test",
        binding,
        activeOrganizationId: binding,
      });

      for (const [path, body] of [
        ["/organization/create", { name: "Sample Firm", slug: "sample-firm" }],
        [
          "/organization/invite-member",
          {
            email: "invitee@example.test",
            role: "member",
            organizationId: "org_account",
          },
        ],
        ["/api-key/create", { name: "Sample key" }],
        ["/update-user", { name: "Renamed" }],
      ] as const) {
        const response = await postAuth({
          auth: demo.auth,
          headers: demo.headers,
          path,
          body,
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          code: "account_access_unavailable",
        });
      }

      const createdOrganization = await postAuth({
        auth: standard.auth,
        headers: standard.headers,
        path: "/organization/create",
        body: { name: "Sample Firm", slug: "sample-firm" },
      });
      expect(createdOrganization.status).toBe(200);
      const createdOrganizationBody: unknown = await createdOrganization.json();
      if (
        typeof createdOrganizationBody !== "object" ||
        createdOrganizationBody === null ||
        !("id" in createdOrganizationBody) ||
        typeof createdOrganizationBody.id !== "string"
      ) {
        panic("Created organization response is required");
      }
      const invite = await postAuth({
        auth: standard.auth,
        headers: standard.headers,
        path: "/organization/invite-member",
        body: {
          email: "invitee@example.test",
          role: "member",
          organizationId: createdOrganizationBody.id,
        },
      });
      expect(invite.status).toBe(200);
      expect(await invite.json()).not.toMatchObject({
        code: "account_access_unavailable",
      });
      const key = await postAuth({
        auth: standard.auth,
        headers: standard.headers,
        path: "/api-key/create",
        body: { name: "Sample key" },
      });
      expect(key.status).toBe(200);
      expect(await key.json()).not.toMatchObject({
        code: "account_access_unavailable",
      });
    },
  );

  test.each([undefined, organizationId])(
    "limits OAuth authorization and consent with binding %s",
    async (binding) => {
      const authorizeQuery = new URLSearchParams({
        response_type: "code",
        client_id: "sample-client",
        redirect_uri: "https://client.example.test/callback",
        scope: "openid",
        state: "sample-state",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGzSMMMgu8",
        code_challenge_method: "S256",
      });
      const requests = [
        {
          method: "GET",
          path: `/oauth2/authorize?${authorizeQuery.toString()}`,
          body: undefined,
        },
        { method: "POST", path: "/oauth2/consent", body: { accept: true } },
        {
          method: "POST",
          path: "/oauth2/register",
          body: {
            client_name: "Sample client",
            redirect_uris: ["https://client.example.test/callback"],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code"],
            response_types: ["code"],
          },
        },
      ] as const;

      for (const accountEmail of [email, "standard@example.test"]) {
        const { auth, headers } = await createAccount({
          accountEmail,
          binding,
          activeOrganizationId: binding,
        });
        for (const request of requests) {
          const response = await auth.handler(
            new Request(`http://localhost:3001/api/auth${request.path}`, {
              method: request.method,
              headers: {
                ...headers,
                "content-type": "application/json",
                origin: "http://localhost:3001",
              },
              body:
                request.body === undefined
                  ? undefined
                  : JSON.stringify(request.body),
            }),
          );
          const text = await response.text();
          if (accountEmail === email) {
            expect(response.status).toBe(403);
            expect(JSON.parse(text)).toMatchObject({
              code: "account_access_unavailable",
            });
          } else {
            expect(text).not.toContain("account_access_unavailable");
          }
        }
      }
    },
  );
});

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { twoFactor } from "better-auth/plugins";
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
    plugins: [createDemoSessionFilter(config), twoFactor()],
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
});

import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { statements } from "@stll/permissions";

import {
  checkDemoAccountAccess,
  createDemoSessionFilter,
  createDemoSessionPolicy,
  requiresStandardAccount,
} from "@/api/lib/demo-account-policy";

const email = "account@example.test";
const organizationId = "00000000-0000-4000-8000-000000000001";
const config = { email, organizationId };

describe("account access policy", () => {
  test("requires the configured organization for session access", () => {
    for (const activeOrganizationId of [
      undefined,
      null,
      organizationId,
      "00000000-0000-4000-8000-000000000002",
    ]) {
      expect(
        Result.isOk(
          checkDemoAccountAccess({
            config,
            email,
            operation: "session",
            organizationId: activeOrganizationId,
          }),
        ),
      ).toBe(activeOrganizationId === organizationId);
    }
  });

  test("requires complete configuration for sign-in", () => {
    expect(
      Result.isError(
        checkDemoAccountAccess({
          config: { email, organizationId: undefined },
          email,
          operation: "sign-in",
        }),
      ),
    ).toBe(true);
    expect(
      Result.isOk(
        checkDemoAccountAccess({ config, email, operation: "sign-in" }),
      ),
    ).toBe(true);
  });

  test("standard accounts retain their existing access", () => {
    for (const operation of ["sign-in", "session", "growth"] as const) {
      expect(
        Result.isOk(
          checkDemoAccountAccess({
            config,
            email: "standard@example.test",
            operation,
          }),
        ),
      ).toBe(true);
      expect(
        Result.isOk(
          checkDemoAccountAccess({
            config: { email: undefined, organizationId: undefined },
            email,
            operation,
          }),
        ),
      ).toBe(true);
    }
  });

  test("applies the same growth policy to each restricted permission", () => {
    const restricted = [
      "organization",
      "member",
      "invitation",
      "team",
      "ac",
      "workspace",
      "organizationSettings",
      "integration",
    ];
    for (const [resource, actions] of Object.entries(statements)) {
      for (const action of actions) {
        const permissions = { [resource]: [action] };
        // Runtime census over the producer; the policy map is total at compile time.
        const policyRequired = requiresStandardAccount(permissions);
        expect(policyRequired).toBe(
          restricted.includes(resource) && action !== "read",
        );
        if (policyRequired) {
          expect(
            Result.isError(
              checkDemoAccountAccess({ config, email, operation: "growth" }),
            ),
          ).toBe(true);
        }
      }
    }
  });

  test.each([
    { binding: undefined, membership: false, allowed: false },
    { binding: organizationId, membership: false, allowed: false },
    { binding: organizationId, membership: true, allowed: true },
  ])(
    "creates a session only when its account policy permits it: %j",
    async ({ binding, membership, allowed }) => {
      const sessions: Record<string, unknown>[] = [];
      const database = {
        user: [],
        session: sessions,
        account: [],
        verification: [],
      };
      const auth = betterAuth({
        baseURL: "http://localhost:3001",
        secret: "test-secret-that-is-long-enough-for-better-auth",
        database: memoryAdapter(database),
        emailAndPassword: { enabled: true },
        session: {
          additionalFields: {
            activeOrganizationId: { type: "string", required: false },
          },
        },
        databaseHooks: {
          session: {
            create: {
              before: createDemoSessionPolicy({
                config: { email, organizationId: binding },
                resolveUser: async () => ({ email }),
                hasMembership: async () => membership,
              }),
            },
          },
        },
      });
      const response = await auth.api.signUpEmail({
        body: { email, name: "Account", password: "A secure password 123!" },
        asResponse: true,
      });
      expect(response.ok).toBe(allowed);
      expect(database.session.length).toBe(allowed ? 1 : 0);
      if (allowed) {
        expect(database.session.at(0)?.["activeOrganizationId"]).toBe(
          organizationId,
        );
      }
    },
  );

  test("applies the account policy to database and cached session resolutions", async () => {
    for (const accountEmail of [email, "standard@example.test"]) {
      for (const activeOrganizationId of [
        organizationId,
        "00000000-0000-4000-8000-000000000002",
      ]) {
        const auth = betterAuth({
          baseURL: "http://localhost:3001",
          secret: "test-secret-that-is-long-enough-for-better-auth",
          database: memoryAdapter({
            user: [],
            session: [],
            account: [],
            verification: [],
          }),
          emailAndPassword: { enabled: true },
          session: {
            cookieCache: { enabled: true, maxAge: 30 },
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
          plugins: [createDemoSessionFilter(config)],
        });
        const response = await auth.api.signUpEmail({
          body: {
            email: accountEmail,
            name: "Account",
            password: "A secure password 123!",
          },
          asResponse: true,
        });
        expect(response.ok).toBe(true);
        const cookie = response.headers
          .getSetCookie()
          .map((value) => value.split(";").at(0))
          .join("; ");
        const allowed =
          accountEmail !== email || activeOrganizationId === organizationId;
        for (const disableCookieCache of [true, false]) {
          const resolved = await auth.api.getSession({
            headers: { cookie },
            query: { disableCookieCache },
          });
          expect(resolved !== null).toBe(allowed);
        }
      }
    }
  });
});

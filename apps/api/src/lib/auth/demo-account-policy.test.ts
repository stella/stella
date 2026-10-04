import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { createDemoSessionPolicy } from "@/api/lib/auth/demo-account-hooks";
import {
  checkDemoAccountAccess,
  createDemoSessionFilter,
  warnDemoAccountConfiguration,
} from "@/api/lib/auth/demo-account-policy";
import {
  logger,
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";
import type { LogRecord } from "@/api/lib/observability/logger";

const email = "account@example.test";
const organizationId = "00000000-0000-4000-8000-000000000001";
const config = { email, organizationId };

describe("account access policy", () => {
  test("warns only when an enabled account has no organization binding", () => {
    try {
      for (const accountEmail of [undefined, email]) {
        for (const binding of [undefined, organizationId]) {
          const records: LogRecord[] = [];
          setLogSinkForTesting((record) => {
            records.push(record);
          });
          warnDemoAccountConfiguration(
            { email: accountEmail, organizationId: binding },
            (attributes) =>
              logger.warn("auth.account_binding_unset", attributes),
          );
          expect(records).toEqual(
            accountEmail && !binding
              ? [
                  {
                    severityText: "WARN",
                    message: "auth.account_binding_unset",
                    attributes: {
                      mode: "unbound",
                      missingConfig: "DEMO_ACCOUNT_ORGANIZATION_ID",
                    },
                  },
                ]
              : [],
          );
        }
      }
    } finally {
      resetLogSinkForTesting();
    }
  });

  test("normalizes configured account identities for access and session creation", async () => {
    for (const accountEmail of [email, " Account@Example.Test "]) {
      for (const configuredEmail of [email, " ACCOUNT@EXAMPLE.TEST "]) {
        const normalizedConfig = { email: configuredEmail, organizationId };
        expect(
          Result.isError(
            checkDemoAccountAccess({
              config: normalizedConfig,
              email: accountEmail,
              operation: "growth",
            }),
          ),
        ).toBe(true);
        const createSession = createDemoSessionPolicy({
          config: normalizedConfig,
          resolveUser: async () => ({ email: accountEmail }),
          hasMembership: async () => true,
        });
        expect(await createSession({ userId: "user_account" })).toEqual({
          data: {
            userId: "user_account",
            activeOrganizationId: organizationId,
          },
        });
      }
    }
  });

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

  test("permits sign-in and session access without a binding but still blocks growth", () => {
    for (const binding of [undefined, organizationId]) {
      expect(
        Result.isOk(
          checkDemoAccountAccess({
            config: { email, organizationId: binding },
            email,
            operation: "sign-in",
          }),
        ),
      ).toBe(true);
      expect(
        Result.isError(
          checkDemoAccountAccess({
            config: { email, organizationId: binding },
            email,
            operation: "growth",
          }),
        ),
      ).toBe(true);
    }
    for (const activeOrganizationId of [
      undefined,
      null,
      organizationId,
      "org_other",
    ]) {
      expect(
        Result.isOk(
          checkDemoAccountAccess({
            config: { email, organizationId: undefined },
            email,
            operation: "session",
            organizationId: activeOrganizationId,
          }),
        ),
      ).toBe(true);
    }
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

  test.each([
    { binding: undefined, membership: false, allowed: true },
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
                resolveUser: async () => {
                  expect(binding).toBeDefined();
                  return { email };
                },
                hasMembership: async () => {
                  expect(binding).toBeDefined();
                  return membership;
                },
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
        expect(database.session.at(0)?.["activeOrganizationId"]).toBe(binding);
      }
    },
  );

  test("applies the account policy to database and cached session resolutions", async () => {
    for (const accountEmail of [email, "standard@example.test"]) {
      for (const binding of [undefined, organizationId]) {
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
            plugins: [
              createDemoSessionFilter({ email, organizationId: binding }),
            ],
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
            accountEmail !== email ||
            binding === undefined ||
            activeOrganizationId === organizationId;
          for (const disableCookieCache of [true, false]) {
            const resolved = await auth.api.getSession({
              headers: { cookie },
              query: { disableCookieCache },
            });
            expect(resolved !== null).toBe(allowed);
          }
        }
      }
    }
  });
});

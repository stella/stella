import { panic } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createTestState } from "@stll/test-state";

import { account, session, ssoProvider } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { env } from "@/api/env";
import { signInHuman } from "@/api/tests/helpers/human-session";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import {
  createIdentityProvider,
  createOrganization,
  fixtureOidcConfig,
  IDP_ORIGIN,
  sessionOf,
  signInWithSso,
  unique,
  verifiedClaims,
} from "@/api/tests/helpers/sso-identity-provider";

const testState = createTestState({ file: import.meta.path, config: env });
// timeout: one email-code sign-in and one SSO sign-in through the real auth
// stack against Postgres.
setDefaultTimeout(120_000);

const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!runPostgres || !process.env["DATABASE_URL"]) {
  describe.skip("organization SSO first sign-in (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {});
  });
} else {
  describe("organization SSO first sign-in (postgres)", () => {
    // The callback writes the user, the account and the session in one
    // transaction. The session's linked-account check reads on the pooled
    // owner connection, which sees that account only once the transaction
    // has committed; an in-process database shares one connection and would
    // see it either way.
    test("a new identity's first sign-in keeps the session its callback created", async () => {
      testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
      const owner = await signInHuman(`sso-pg-owner-${unique()}@stella.dev`);
      const organization = await createOrganization(owner, "pg-first");
      const domain = `pg-first-${unique()}.test`;
      const provider = {
        id: Bun.randomUUIDv7(),
        providerId: `sso_${unique()}`,
      };
      try {
        await rootDb.insert(ssoProvider).values({
          ...provider,
          organizationId: organization.id,
          issuer: IDP_ORIGIN,
          domain,
          oidcConfig: fixtureOidcConfig(),
        });
        const email = `pg-first-${unique()}@${domain}`;
        const signedIn = await signInWithSso(
          await createIdentityProvider(),
          provider.providerId,
          verifiedClaims(`pg-first-${unique()}`, email),
        );
        expect(signedIn.location.searchParams.get("error")).toBeNull();
        const current = await sessionOf(signedIn.cookieHeader());
        const userId =
          current?.user.id ?? panic("the first SSO sign-in kept no session");
        expect(current?.user.email).toBe(email);
        expect(
          await rootDb
            .select({ ssoProviderId: session.ssoProviderId })
            .from(session)
            .where(eq(session.userId, userId)),
        ).toEqual([{ ssoProviderId: provider.id }]);
        expect(
          await rootDb
            .select({ providerId: account.providerId })
            .from(account)
            .where(eq(account.userId, userId)),
        ).toEqual([{ providerId: provider.providerId }]);
      } finally {
        await deleteOrganizationsForTest(rootDb, [organization.id]);
      }
    });
  });
}

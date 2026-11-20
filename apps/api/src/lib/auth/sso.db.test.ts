import { panic } from "better-result";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { SSO_SIGN_IN_REQUIRED_CODE } from "@stll/api-contract/sso";
import { rejectionOf } from "@stll/property-testing/rejection";
import { createTestState } from "@stll/test-state";

import {
  account,
  session,
  ssoProvider,
  twoFactor,
  user,
} from "@/api/db/auth-schema";
import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { getAuth, resolveMemberAuthorization } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import type { MemberAuthentication } from "@/api/lib/auth/member-authorization";
import { ORGANIZATION_ENDPOINT_SSO } from "@/api/lib/auth/sso-organization-guard";
import { sealText } from "@/api/lib/db/sealed-text";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { isPgConstraintError, isPgError, PG_ERROR } from "@/api/lib/pg-error";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import {
  addMember,
  CLIENT_ID,
  createIdentityProvider,
  createOrganization,
  fixtureOidcConfig,
  IDP_ORIGIN,
  registerProvider,
  sessionOf,
  setSsoRequirement,
  signInWithSso,
  unique,
  verifiedClaims,
} from "@/api/tests/helpers/sso-identity-provider";
import type { TokenFault } from "@/api/tests/helpers/sso-identity-provider";
import { serveForTest } from "@/api/tests/helpers/test-server";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const testState = createTestState({ file: import.meta.path, config: env });
// timeout: each test drives full email-code and SSO sign-ins through the real auth
// stack on an in-process database.
setDefaultTimeout(120_000);

let testDb: TestDatabase;

testState.beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const ssoAccessFor = async (
  organizationId: string,
  userId: string,
  authentication: MemberAuthentication,
) =>
  (
    await resolveMemberAuthorization(
      {
        organizationId: brandPersistedOrganizationId(organizationId),
        userId: brandPersistedUserId(userId),
        authentication,
      },
      testDb,
    )
  )?.ssoAccess.status;

const browserSession = (
  sessionId: string | undefined,
): MemberAuthentication => ({
  kind: "browser_session",
  sessionId: sessionId ?? "",
});

/** An organization with one provider for a fresh domain, and its owner. */
const providerFixture = async (name: string) => {
  const owner = await signInHuman(`sso-${name}-owner-${unique()}@stella.dev`);
  const organization = await createOrganization(owner, name);
  const domain = `${name}-${unique()}.test`;
  const provider = await registerProvider(testDb, organization.id, [domain]);
  return { owner, organization, domain, provider };
};

describe("organization SSO", () => {
  test("is hidden while the deployment switch is off, and decides nothing", async () => {
    testState.setConfig("FEATURE_ENTERPRISE_SSO", false);
    const { owner, organization, provider } = await providerFixture("off");
    await setSsoRequirement(testDb, organization.id, "required");

    const started = await getAuth().handler(
      new Request(getAuthEndpointUrl("sign-in/sso"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: new URL(env.FRONTEND_URL).origin,
        },
        body: JSON.stringify({
          providerId: provider.providerId,
          callbackURL: "/",
        }),
      }),
    );
    expect(started.status).toBe(404);

    const ownerSession = await sessionOf(owner.cookieHeader());
    expect(ownerSession?.session.id).toBeString();
    // The requirement exists, yet a password-less session still reaches the
    // organization exactly as before.
    expect(
      await ssoAccessFor(
        organization.id,
        owner.userId,
        browserSession(ownerSession?.session.id),
      ),
    ).toBe("not_required");
  });

  test("signs a new identity in through the real callback, bound to its provider generation", async () => {
    testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
    const idp = await createIdentityProvider();
    const { organization, domain } = await providerFixture("signin");
    // Several domains per provider: the second one admits the address.
    const provider = await registerProvider(testDb, organization.id, [
      `other-${unique()}.test`,
      domain,
    ]);
    const email = `person-${unique()}@${domain}`;
    const subject = `subject-${unique()}`;

    const signedIn = await signInWithSso(
      idp,
      provider.providerId,
      verifiedClaims(subject, email),
    );
    expect(signedIn.location.searchParams.get("error")).toBeNull();
    // The code exchange carried the verifier for the challenge the browser
    // was sent with.
    expect(idp.tokenExchanges.at(-1)).toEqual({ verifierMatched: true });

    const current = await sessionOf(signedIn.cookieHeader());
    expect(current?.user.email).toBe(email);
    const stored = await testDb
      .select({ ssoProviderId: session.ssoProviderId })
      .from(session)
      .where(eq(session.id, current?.session.id ?? ""));
    expect(stored).toEqual([{ ssoProviderId: provider.id }]);

    // The identity is the provider and the subject, bound to the provider
    // row that created it; the provider's tokens are not kept.
    const accounts = await testDb
      .select({
        providerId: account.providerId,
        accountId: account.accountId,
        ssoProviderId: account.ssoProviderId,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        idToken: account.idToken,
      })
      .from(account)
      .where(eq(account.userId, current?.user.id ?? ""));
    expect(accounts).toEqual([
      {
        providerId: provider.providerId,
        accountId: subject,
        ssoProviderId: provider.id,
        accessToken: null,
        refreshToken: null,
        idToken: null,
      },
    ]);

    // A second sign-in finds the same account by provider and subject, even
    // after the provider reports another address, which never replaces the
    // local one.
    const again = await signInWithSso(
      idp,
      provider.providerId,
      verifiedClaims(subject, `renamed-${unique()}@${domain}`),
    );
    expect(again.location.searchParams.get("error")).toBeNull();
    const second = await sessionOf(again.cookieHeader());
    expect(second?.user.id).toBe(current?.user.id);
    expect(second?.user.email).toBe(email);
  });

  // By design the identity provider owns MFA. An SSO sign-in
  // never asks for this app's second factor, even after the account enrolled
  // one; see the classification in session-path-classification.ts.
  test("creates an SSO session for an account with local two-factor without a local challenge", async () => {
    testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
    const idp = await createIdentityProvider();
    const { provider, domain } = await providerFixture("totp");
    const subject = `totp-${unique()}`;
    const email = `totp-${unique()}@${domain}`;
    const first = await signInWithSso(
      idp,
      provider.providerId,
      verifiedClaims(subject, email),
    );
    const userId = (await sessionOf(first.cookieHeader()))?.user.id ?? "";
    await testDb
      .update(user)
      .set({ twoFactorEnabled: true })
      .where(eq(user.id, userId));
    await testDb.insert(twoFactor).values({
      id: Bun.randomUUIDv7(),
      userId,
      secret: "fixture-totp-secret",
      backupCodes: "fixture-backup-codes",
    });

    const second = await signInWithSso(
      idp,
      provider.providerId,
      verifiedClaims(subject, email),
    );
    expect(second.location.searchParams.get("error")).toBeNull();
    expect(second.location.pathname).not.toContain("two-factor");
    expect(second.cookieHeader()).not.toContain("two_factor");
    expect((await sessionOf(second.cookieHeader()))?.user.id).toBe(userId);
  });

  test("never links an existing account by email alone", async () => {
    testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
    const idp = await createIdentityProvider();
    const domain = `link-${unique()}.test`;
    const existingEmail = `existing-${unique()}@${domain}`;
    const existing = await signInHuman(existingEmail);
    const organization = await createOrganization(existing, "link");
    const provider = await registerProvider(testDb, organization.id, [domain]);

    const refused = await signInWithSso(
      idp,
      provider.providerId,
      verifiedClaims(`attacker-${unique()}`, existingEmail),
    );
    expect(refused.location.searchParams.get("error")).toBe(
      "sso_account_link_unavailable",
    );
    expect(await sessionOf(refused.cookieHeader())).toBeNull();
    const accounts = await testDb
      .select({ providerId: account.providerId })
      .from(account)
      .where(eq(account.userId, existing.userId));
    expect(accounts.map((row) => row.providerId)).not.toContain(
      provider.providerId,
    );
  });

  test.each([
    {
      name: "an address outside the provider's domains",
      // A subdomain is another domain: only listed domains match.
      addressDomain: (domain: string) => `mail.${domain}`,
      emailVerified: true,
      error: "sso_email_domain_not_allowed",
    },
    {
      name: "an address the ID token does not verify",
      addressDomain: (domain: string) => domain,
      emailVerified: false,
      error: "sso_email_unverified",
    },
  ])(
    "refuses to create an account for $name",
    async ({ addressDomain, emailVerified, error }) => {
      testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
      const idp = await createIdentityProvider();
      const { provider, domain } = await providerFixture("refuse");

      const refused = await signInWithSso(idp, provider.providerId, {
        ...verifiedClaims(
          `refused-${unique()}`,
          `x-${unique()}@${addressDomain(domain)}`,
        ),
        email_verified: emailVerified,
      });
      expect(refused.location.searchParams.get("error")).toBe(error);
      expect(await sessionOf(refused.cookieHeader())).toBeNull();
    },
  );

  test.each([
    {
      name: "a token signed with a key the provider does not publish",
      fault: { foreignKey: true },
      error: "sso_sign_in_failed",
    },
    {
      name: "a token from another issuer",
      fault: { issuer: "https://elsewhere.sso-fixture.test" },
      error: "sso_sign_in_failed",
    },
    {
      name: "a token for another client",
      fault: { audience: "another-client" },
      error: "sso_sign_in_failed",
    },
    {
      name: "an expired token",
      fault: { expiredFor: 3600 },
      error: "sso_sign_in_failed",
    },
    {
      name: "a token whose nonce another request carried",
      fault: { nonce: "nonce-of-another-request" },
      error: "sso_nonce_mismatch",
    },
    {
      name: "a token without a nonce",
      fault: { nonce: null },
      error: "sso_nonce_mismatch",
    },
  ] satisfies { name: string; fault: TokenFault; error: string }[])(
    "refuses $name with a stable public error",
    async ({ fault, error }) => {
      testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
      const idp = await createIdentityProvider();
      const { provider, domain } = await providerFixture("fault");

      const refused = await signInWithSso(
        idp,
        provider.providerId,
        verifiedClaims(`fault-${unique()}`, `fault-${unique()}@${domain}`),
        { fault },
      );
      expect(refused.location.searchParams.get("error")).toBe(error);
      expect(refused.location.searchParams.has("error_description")).toBe(
        false,
      );
      expect(await sessionOf(refused.cookieHeader())).toBeNull();
    },
  );

  test("refuses a callback whose state the sign-in did not issue", async () => {
    testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
    const idp = await createIdentityProvider();
    const { provider, domain } = await providerFixture("state");

    const refused = await signInWithSso(
      idp,
      provider.providerId,
      verifiedClaims(`state-${unique()}`, `state-${unique()}@${domain}`),
      { state: (issued) => `${issued}tampered` },
    );
    expect(refused.location.searchParams.get("error")).toBe(
      "sso_sign_in_failed",
    );
    expect(refused.location.searchParams.has("error_description")).toBe(false);
    expect(await sessionOf(refused.cookieHeader())).toBeNull();
  });

  test("refuses user info that names another subject than the ID token", async () => {
    testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
    const idp = await createIdentityProvider();
    const owner = await signInHuman(`sso-userinfo-${unique()}@stella.dev`);
    const organization = await createOrganization(owner, "userinfo");
    const domain = `userinfo-${unique()}.test`;
    const provider = await registerProvider(testDb, organization.id, [domain], {
      config: { userInfoEndpoint: `${IDP_ORIGIN}/userinfo` },
    });

    const refused = await signInWithSso(
      idp,
      provider.providerId,
      verifiedClaims(`userinfo-${unique()}`, `ui-${unique()}@${domain}`),
      { fault: { userInfoSubject: `someone-else-${unique()}` } },
    );
    expect(refused.location.searchParams.get("error")).toBe(
      "sso_sign_in_failed",
    );
    expect(await sessionOf(refused.cookieHeader())).toBeNull();
  });

  test("admits an address the ID token verifies when user info leaves out email_verified", async () => {
    testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
    const idp = await createIdentityProvider();
    const owner = await signInHuman(`sso-uiclaims-${unique()}@stella.dev`);
    const organization = await createOrganization(owner, "uiclaims");
    const domain = `uiclaims-${unique()}.test`;
    const provider = await registerProvider(testDb, organization.id, [domain], {
      config: { userInfoEndpoint: `${IDP_ORIGIN}/userinfo` },
    });
    const email = `uiclaims-${unique()}@${domain}`;

    const signedIn = await signInWithSso(
      idp,
      provider.providerId,
      verifiedClaims(`uiclaims-${unique()}`, email),
      { fault: { userInfoOmits: ["email_verified"] } },
    );
    expect(signedIn.location.searchParams.get("error")).toBeNull();
    // The account records the address as the signed ID token verified it.
    const created = await testDb
      .select({ email: user.email, emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.id, signedIn.userId ?? panic("the sign-in was refused")));
    expect(created).toEqual([{ email, emailVerified: true }]);
  });

  test("a provider recreated under the same id does not inherit the earlier provider's identities or sessions", async () => {
    testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
    const idp = await createIdentityProvider();
    const { organization, provider, domain } =
      await providerFixture("generation");
    await setSsoRequirement(testDb, organization.id, "required");
    const subject = `generation-${unique()}`;
    const signedIn = await signInWithSso(
      idp,
      provider.providerId,
      verifiedClaims(subject, `gen-${unique()}@${domain}`),
    );
    const earlier = await sessionOf(signedIn.cookieHeader());
    await addMember(testDb, organization.id, earlier?.user.id ?? "");
    expect(
      await ssoAccessFor(
        organization.id,
        earlier?.user.id ?? "",
        browserSession(earlier?.session.id),
      ),
    ).toBe("satisfied");

    await testDb.delete(ssoProvider).where(eq(ssoProvider.id, provider.id));
    const replacement = await registerProvider(
      testDb,
      organization.id,
      [domain],
      { providerId: provider.providerId },
    );
    expect(replacement.id).not.toBe(provider.id);

    // The earlier session reaches nothing through the replacement row.
    expect(
      await ssoAccessFor(
        organization.id,
        earlier?.user.id ?? "",
        browserSession(earlier?.session.id),
      ),
    ).toBe("sign_in_required");
    // The same subject at the replacement does not sign in as the identity
    // the earlier provider created.
    const refused = await signInWithSso(
      idp,
      provider.providerId,
      verifiedClaims(subject, `gen-${unique()}@${domain}`),
    );
    expect(refused.location.searchParams.get("error")).toBe(
      "sso_provider_replaced",
    );
    expect(await sessionOf(refused.cookieHeader())).toBeNull();
  });

  test.each([
    { field: "issuer", value: "https://moved.sso-fixture.test" },
    { field: "organization_id", value: "another-organization" },
    { field: "provider_id", value: "sso_renamed" },
  ])(
    "refuses to change a provider's $field after creation",
    async ({ field, value }) => {
      const { provider } = await providerFixture("immutable");

      const refused = await rejectionOf(
        testDb.execute(
          sql`update sso_provider set ${sql.identifier(field)} = ${value} where id = ${provider.id}`,
        ),
      );
      expect(isPgError(refused, PG_ERROR.CHECK_VIOLATION)).toBe(true);
      // Its domains may change: they gate account creation, not trust.
      await testDb
        .update(ssoProvider)
        .set({ domain: `changed-${unique()}.test` })
        .where(eq(ssoProvider.id, provider.id));
    },
  );

  test.each([
    { name: "overrides user profiles", config: { overrideUserInfo: true } },
    { name: "does not require PKCE", config: { pkce: false } },
    {
      name: "allows identity-provider-initiated sign-in",
      config: { allowIdpInitiated: true },
    },
  ])(
    "refuses to store a provider configuration that $name",
    async ({ config }) => {
      const owner = await signInHuman(`sso-admit-${unique()}@stella.dev`);
      const organization = await createOrganization(owner, "admit");
      const refused = await rejectionOf(
        registerProvider(testDb, organization.id, ["admit.test"], { config }),
      );
      expect(String(refused)).toContain("SSO provider configuration");
    },
  );

  test("refuses to use a stored configuration that overrides user profiles", async () => {
    testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
    const { provider } = await providerFixture("override");
    // Written around the column's admission, as a direct database edit
    // would be.
    const sealed = sealText(
      "stella:sealed-text:v1:sso_provider.oidc_config",
      fixtureOidcConfig({ overrideUserInfo: true }),
    ).unwrap();
    await testDb.execute(
      sql`update sso_provider set oidc_config = ${sealed} where id = ${provider.id}`,
    );

    const read = await rejectionOf(
      testDb
        .select({ oidcConfig: ssoProvider.oidcConfig })
        .from(ssoProvider)
        .where(eq(ssoProvider.id, provider.id)),
    );
    expect(String(read)).toContain("may not override user profiles");
    const started = await getAuth().handler(
      new Request(getAuthEndpointUrl("sign-in/sso"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: new URL(env.FRONTEND_URL).origin,
        },
        body: JSON.stringify({
          providerId: provider.providerId,
          callbackURL: "/",
        }),
      }),
    );
    expect(started.status).not.toBe(200);
  });

  test("a required organization admits only its providers' sessions, and refuses the rest without signing them out", async () => {
    testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
    const idp = await createIdentityProvider();
    const owner = await signInHuman(`sso-gate-owner-${unique()}@stella.dev`);
    const required = await createOrganization(owner, "required");
    const open = await createOrganization(owner, "open");
    const foreign = await createOrganization(owner, "foreign");
    const domain = `gate-${unique()}.test`;
    const provider = await registerProvider(testDb, required.id, [domain]);
    const foreignProvider = await registerProvider(testDb, foreign.id, [
      domain,
    ]);
    await setSsoRequirement(testDb, required.id, "required");

    const viaProvider = await signInWithSso(
      idp,
      provider.providerId,
      verifiedClaims(`gate-${unique()}`, `member-${unique()}@${domain}`),
    );
    const viaForeign = await signInWithSso(
      idp,
      foreignProvider.providerId,
      verifiedClaims(`gate-${unique()}`, `foreign-${unique()}@${domain}`),
    );
    const ssoSession = await sessionOf(viaProvider.cookieHeader());
    const foreignSession = await sessionOf(viaForeign.cookieHeader());
    const ownerSession = await sessionOf(owner.cookieHeader());
    for (const signedIn of [ssoSession, foreignSession]) {
      await addMember(testDb, required.id, signedIn?.user.id ?? "");
      await addMember(testDb, open.id, signedIn?.user.id ?? "");
    }

    expect(
      await ssoAccessFor(
        required.id,
        ssoSession?.user.id ?? "",
        browserSession(ssoSession?.session.id),
      ),
    ).toBe("satisfied");
    expect(
      await ssoAccessFor(
        required.id,
        foreignSession?.user.id ?? "",
        browserSession(foreignSession?.session.id),
      ),
    ).toBe("sign_in_required");
    expect(
      await ssoAccessFor(
        required.id,
        owner.userId,
        browserSession(ownerSession?.session.id),
      ),
    ).toBe("sign_in_required");
    // Another person's SSO session id proves nothing for this account.
    expect(
      await ssoAccessFor(
        required.id,
        owner.userId,
        browserSession(ssoSession?.session.id),
      ),
    ).toBe("sign_in_required");
    expect(
      await ssoAccessFor(
        open.id,
        owner.userId,
        browserSession(ownerSession?.session.id),
      ),
    ).toBe("not_required");
    // Credentials other than a browser session are not evaluated yet.
    expect(
      await ssoAccessFor(required.id, owner.userId, { kind: "credential" }),
    ).toBe("not_evaluated");

    const server = serveForTest(
      createHttpApp({
        middleware: [errorBoundary],
        routes: [
          ...routes({
            "/product": {
              GET: defineEndpoint.member({}, () => ({ served: true })),
            },
          }),
        ],
      }),
    );
    try {
      const readProduct = async () =>
        await server.fetch("http://localhost/product", {
          headers: owner.headers(),
        });
      await owner.setActiveOrganization(required.id);
      const refused = await readProduct();
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({
        code: SSO_SIGN_IN_REQUIRED_CODE,
        message: expect.any(String),
      });
      expect((await sessionOf(owner.cookieHeader()))?.session.id).toBe(
        ownerSession?.session.id,
      );

      await owner.setActiveOrganization(open.id);
      const served = await readProduct();
      expect(served.status).toBe(200);
      expect(await served.json()).toEqual({ served: true });
    } finally {
      await server.stop();
    }
  });

  test("seals the provider configuration at rest and keeps both tables from the request role", async () => {
    const { provider } = await providerFixture("seal");

    const raw = await testDb.execute<{ oidc_config: string }>(
      sql`select oidc_config from sso_provider where id = ${provider.id}`,
    );
    const stored = raw.rows.at(0)?.oidc_config ?? "";
    expect(stored).toStartWith("v1.");
    expect(stored).not.toContain("fixture-client-secret");
    expect(stored).not.toContain(CLIENT_ID);

    const [opened] = await testDb
      .select({ oidcConfig: ssoProvider.oidcConfig })
      .from(ssoProvider)
      .where(eq(ssoProvider.id, provider.id));
    expect(JSON.parse(opened?.oidcConfig ?? "{}")).toMatchObject({
      clientId: CLIENT_ID,
      clientSecret: "fixture-client-secret",
    });

    for (const table of ["sso_provider", "organization_sso_policy"]) {
      const denied = await rejectionOf(
        testDb.transaction(async (tx) => {
          await tx.execute(sql`set local role stella`);
          await tx.execute(sql.raw(`select count(*) from ${table}`));
        }),
      );
      expect(isPgError(denied, PG_ERROR.INSUFFICIENT_PRIVILEGE), table).toBe(
        true,
      );
    }
  });

  test("refuses a provider id that could shadow a social provider", async () => {
    const owner = await signInHuman(`sso-shadow-${unique()}@stella.dev`);
    const organization = await createOrganization(owner, "shadow");
    const refused = await rejectionOf(
      testDb.insert(ssoProvider).values({
        id: Bun.randomUUIDv7(),
        providerId: "google",
        organizationId: organization.id,
        issuer: IDP_ORIGIN,
        domain: "shadow.test",
        oidcConfig: fixtureOidcConfig(),
      }),
    );
    expect(
      isPgConstraintError(
        refused,
        PG_ERROR.CHECK_VIOLATION,
        "sso_provider_provider_id_check",
      ),
    ).toBe(true);
    const rows = await testDb
      .select({ id: ssoProvider.id })
      .from(ssoProvider)
      .where(
        and(
          eq(ssoProvider.organizationId, organization.id),
          eq(ssoProvider.providerId, "google"),
        ),
      );
    expect(rows).toEqual([]);
  });

  test("classifies every mounted organization endpoint for the SSO decision", () => {
    const auth = getAuth();
    const disabled = new Set(auth.options.disabledPaths);
    const mounted = Object.values(auth.api)
      .map((endpoint) => endpoint.path)
      .filter(
        (path): path is string =>
          typeof path === "string" &&
          path.startsWith("/organization/") &&
          !disabled.has(path),
      );
    expect(mounted.length).toBeGreaterThan(0);
    expect(
      mounted.filter((path) => !Object.hasOwn(ORGANIZATION_ENDPOINT_SSO, path)),
    ).toEqual([]);
  });
});

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import * as v from "valibot";

import { SSO_SIGN_IN_REQUIRED_CODE } from "@stll/api-contract/sso";
import { rejectionOf } from "@stll/property-testing/rejection";
import { createTestState } from "@stll/test-state";

import {
  account,
  member,
  organizationSsoPolicy,
  session,
  ssoProvider,
} from "@/api/db/auth-schema";
import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { getAuth, resolveMemberAuthorization } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import type { MemberAuthentication } from "@/api/lib/auth/member-authorization";
import { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { isPgConstraintError, isPgError, PG_ERROR } from "@/api/lib/pg-error";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import { withTestFetchInterceptor } from "@/api/tests/helpers/test-fetch";
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

// The identity provider answers in-process: its host only needs to pass the
// plugin's public-host check, and nothing leaves the test.
const IDP_ORIGIN = "https://idp.sso-fixture.test";
const CLIENT_ID = "stella-fixture-client";
const KEY_ID = "fixture-signing-key";

/**
 * A local OIDC identity provider: generated signing keys, a JWKS document
 * and a token endpoint that signs the next ID token a test asks for.
 */
const createIdentityProvider = async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    kid: KEY_ID,
    alg: "RS256",
    use: "sig",
  };
  let claims: JWTPayload = {};
  const handle = async (url: URL): Promise<Response> => {
    switch (url.pathname) {
      case "/jwks":
        return Response.json({ keys: [publicJwk] });
      case "/token": {
        const idToken = await new SignJWT(claims)
          .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
          .setIssuer(IDP_ORIGIN)
          .setAudience(CLIENT_ID)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        return Response.json({
          access_token: "fixture-idp-access-token",
          refresh_token: "fixture-idp-refresh-token",
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 300,
        });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  };
  return {
    willAssert: (next: JWTPayload) => {
      claims = next;
    },
    handle,
  };
};

type IdentityProvider = Awaited<ReturnType<typeof createIdentityProvider>>;

const unique = () => Bun.randomUUIDv7().replaceAll("-", "").slice(-12);

const createOrganization = async (owner: HumanBrowser, name: string) =>
  await getAuth().api.createOrganization({
    body: { name, slug: `sso-${name}-${unique()}` },
    headers: owner.headers(),
  });

const addMember = async (organizationId: string, userId: string) => {
  await testDb.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId,
    userId,
    role: "member",
    createdAt: new Date(0),
  });
};

type Provider = { id: string; providerId: string };

const registerProvider = async (
  organizationId: string,
  domains: readonly string[],
): Promise<Provider> => {
  const provider = {
    id: Bun.randomUUIDv7(),
    providerId: `sso_${unique()}`,
  };
  await testDb.insert(ssoProvider).values({
    ...provider,
    organizationId,
    issuer: IDP_ORIGIN,
    domain: domains.join(","),
    oidcConfig: JSON.stringify({
      issuer: IDP_ORIGIN,
      clientId: CLIENT_ID,
      clientSecret: "fixture-client-secret",
      authorizationEndpoint: `${IDP_ORIGIN}/authorize`,
      tokenEndpoint: `${IDP_ORIGIN}/token`,
      jwksEndpoint: `${IDP_ORIGIN}/jwks`,
      discoveryEndpoint: `${IDP_ORIGIN}/.well-known/openid-configuration`,
      pkce: true,
      scopes: ["openid", "email", "profile"],
    }),
  });
  return provider;
};

const requireSso = async (organizationId: string) => {
  await testDb
    .insert(organizationSsoPolicy)
    .values({ organizationId, requirement: "required" });
};

const cookiePairs = (response: Response): string[] =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";").at(0) ?? "")
    .filter((pair) => pair.includes("="));

const signInStartSchema = v.object({ url: v.string(), redirect: v.boolean() });

type SsoSignIn = {
  /** Where the callback sent the browser. */
  location: URL;
  /** The browser's cookies after the callback. */
  cookieHeader: string;
};

/**
 * One SSO sign-in through the real endpoints: start it, let the identity
 * provider assert `claims`, and follow the provider-specific callback.
 */
const signInWithSso = async (
  idp: IdentityProvider,
  providerId: string,
  claims: JWTPayload,
): Promise<SsoSignIn> => {
  const address = `203.0.113.${String(Math.floor(Math.random() * 254) + 1)}`;
  const started = await getAuth().handler(
    new Request(getAuthEndpointUrl("sign-in/sso"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: new URL(env.FRONTEND_URL).origin,
        [AUTH_CLIENT_ADDRESS_HEADER]: address,
      },
      body: JSON.stringify({ providerId, callbackURL: "/" }),
    }),
  );
  expect(started.status).toBe(200);
  const { url } = v.parse(signInStartSchema, await started.json());
  const authorization = new URL(url);
  expect(authorization.origin).toBe(IDP_ORIGIN);
  const state = authorization.searchParams.get("state");
  expect(state).not.toBeNull();

  idp.willAssert(claims);
  const callbackUrl = new URL(getAuthEndpointUrl(`sso/callback/${providerId}`));
  callbackUrl.searchParams.set("code", "fixture-authorization-code");
  callbackUrl.searchParams.set("state", state ?? "");
  const startCookies = cookiePairs(started);
  const callback = await withTestFetchInterceptor(
    async (input, init, delegate) => {
      const target = new URL(input instanceof Request ? input.url : input);
      return target.origin === IDP_ORIGIN
        ? await idp.handle(target)
        : await delegate(input, init);
    },
    async () =>
      await getAuth().handler(
        new Request(callbackUrl.toString(), {
          headers: {
            cookie: startCookies.join("; "),
            [AUTH_CLIENT_ADDRESS_HEADER]: address,
          },
        }),
      ),
  );
  expect(callback.status).toBe(302);
  return {
    location: new URL(callback.headers.get("location") ?? "", env.FRONTEND_URL),
    cookieHeader: [...startCookies, ...cookiePairs(callback)].join("; "),
  };
};

const sessionOf = async (cookieHeader: string) =>
  await getAuth().api.getSession({
    headers: new Headers({ cookie: cookieHeader }),
    query: { disableCookieCache: true },
  });

const verifiedClaims = (subject: string, email: string): JWTPayload => ({
  sub: subject,
  email,
  email_verified: true,
  name: "Fixture Person",
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

describe("organization SSO", () => {
  test("is hidden while the deployment switch is off, and decides nothing", async () => {
    testState.setConfig("FEATURE_ENTERPRISE_SSO", false);
    const owner = await signInHuman(`sso-off-${unique()}@stella.dev`);
    const organization = await createOrganization(owner, "off");
    const provider = await registerProvider(organization.id, ["off.test"]);
    await requireSso(organization.id);

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
      await ssoAccessFor(organization.id, owner.userId, {
        kind: "browser_session",
        sessionId: ownerSession?.session.id ?? "",
      }),
    ).toBe("not_required");
  });

  test("signs a new identity in through the real callback and records the provider on the session", async () => {
    testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
    const idp = await createIdentityProvider();
    const owner = await signInHuman(`sso-owner-${unique()}@stella.dev`);
    const organization = await createOrganization(owner, "signin");
    const domain = `signin-${unique()}.test`;
    const provider = await registerProvider(organization.id, [
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

    const current = await sessionOf(signedIn.cookieHeader);
    expect(current?.user.email).toBe(email);
    const stored = await testDb
      .select({ ssoProviderId: session.ssoProviderId })
      .from(session)
      .where(eq(session.id, current?.session.id ?? ""));
    expect(stored).toEqual([{ ssoProviderId: provider.id }]);

    // The identity is the provider and the subject; the provider's tokens
    // are not kept on the account.
    const accounts = await testDb
      .select({
        providerId: account.providerId,
        accountId: account.accountId,
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
        accessToken: null,
        refreshToken: null,
        idToken: null,
      },
    ]);

    // A second sign-in finds the same account by provider and subject, even
    // after the provider reports another address.
    const again = await signInWithSso(
      idp,
      provider.providerId,
      verifiedClaims(subject, `renamed-${unique()}@${domain}`),
    );
    expect(again.location.searchParams.get("error")).toBeNull();
    expect((await sessionOf(again.cookieHeader))?.user.id).toBe(
      current?.user.id,
    );
  });

  test("never links an existing account by email alone", async () => {
    testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
    const idp = await createIdentityProvider();
    const domain = `link-${unique()}.test`;
    const existingEmail = `existing-${unique()}@${domain}`;
    const existing = await signInHuman(existingEmail);
    const organization = await createOrganization(existing, "link");
    const provider = await registerProvider(organization.id, [domain]);

    const refused = await signInWithSso(
      idp,
      provider.providerId,
      verifiedClaims(`attacker-${unique()}`, existingEmail),
    );
    expect(refused.location.searchParams.get("error")).toBe(
      "sso_account_link_unavailable",
    );
    expect(await sessionOf(refused.cookieHeader)).toBeNull();
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
      const owner = await signInHuman(`sso-refuse-${unique()}@stella.dev`);
      const organization = await createOrganization(owner, "refuse");
      const domain = `refuse-${unique()}.test`;
      const provider = await registerProvider(organization.id, [domain]);

      const refused = await signInWithSso(idp, provider.providerId, {
        ...verifiedClaims(
          `refused-${unique()}`,
          `x-${unique()}@${addressDomain(domain)}`,
        ),
        email_verified: emailVerified,
      });
      expect(refused.location.searchParams.get("error")).toBe(error);
      expect(await sessionOf(refused.cookieHeader)).toBeNull();
    },
  );

  test("a required organization admits only its providers' sessions, and refuses the rest without signing them out", async () => {
    testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
    const idp = await createIdentityProvider();
    const owner = await signInHuman(`sso-gate-owner-${unique()}@stella.dev`);
    const required = await createOrganization(owner, "required");
    const open = await createOrganization(owner, "open");
    const foreign = await createOrganization(owner, "foreign");
    const domain = `gate-${unique()}.test`;
    const provider = await registerProvider(required.id, [domain]);
    const foreignProvider = await registerProvider(foreign.id, [domain]);
    await requireSso(required.id);

    // A person signed in through the required organization's provider, and
    // the same kind of person through another organization's provider.
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
    const ssoSession = await sessionOf(viaProvider.cookieHeader);
    const foreignSession = await sessionOf(viaForeign.cookieHeader);
    const ownerSession = await sessionOf(owner.cookieHeader());
    for (const signedIn of [ssoSession, foreignSession]) {
      await addMember(required.id, signedIn?.user.id ?? "");
      await addMember(open.id, signedIn?.user.id ?? "");
    }
    const browserSession = (
      current: Awaited<ReturnType<typeof sessionOf>>,
    ): MemberAuthentication => ({
      kind: "browser_session",
      sessionId: current?.session.id ?? "",
    });

    expect(
      await ssoAccessFor(
        required.id,
        ssoSession?.user.id ?? "",
        browserSession(ssoSession),
      ),
    ).toBe("satisfied");
    expect(
      await ssoAccessFor(
        required.id,
        foreignSession?.user.id ?? "",
        browserSession(foreignSession),
      ),
    ).toBe("sign_in_required");
    expect(
      await ssoAccessFor(
        required.id,
        owner.userId,
        browserSession(ownerSession),
      ),
    ).toBe("sign_in_required");
    // Another person's SSO session id proves nothing for this account.
    expect(
      await ssoAccessFor(required.id, owner.userId, browserSession(ssoSession)),
    ).toBe("sign_in_required");
    expect(
      await ssoAccessFor(open.id, owner.userId, browserSession(ownerSession)),
    ).toBe("not_required");
    // Credentials other than a browser session are not evaluated yet.
    expect(
      await ssoAccessFor(required.id, owner.userId, { kind: "credential" }),
    ).toBe("not_evaluated");

    // Over HTTP: the required organization refuses the password-less session
    // with the typed reason, the open one still serves it, and the session
    // survives the refusal.
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

    // Deleting the provider ends what its sessions reach; the requirement
    // stays with the organization.
    await testDb.delete(ssoProvider).where(eq(ssoProvider.id, provider.id));
    expect(
      await ssoAccessFor(
        required.id,
        ssoSession?.user.id ?? "",
        browserSession(ssoSession),
      ),
    ).toBe("sign_in_required");
  });

  test("seals the provider configuration at rest and keeps both tables from the request role", async () => {
    const owner = await signInHuman(`sso-seal-${unique()}@stella.dev`);
    const organization = await createOrganization(owner, "seal");
    const provider = await registerProvider(organization.id, ["seal.test"]);

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
        oidcConfig: "{}",
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
});

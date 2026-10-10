import type { SchemaClient } from "@better-auth/oauth-provider";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { MCP_DEFAULT_RESOURCE_SCOPES } from "@stll/api-contract";

import { getAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import {
  OAUTH_ENDPOINT_POLICY,
  OAUTH_SCOPE_POLICY_PATHS,
  OPEN_REGISTRATION_SCOPES,
  OAUTH_REGISTRATION_SCOPE_POLICY,
} from "@/api/lib/auth/oauth-registration-policy";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";
import { MCP_OAUTH_SCOPES } from "@/api/mcp/constants";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import {
  OAUTH_CLIENT_REGISTRATION_FIXTURES,
  OAUTH_REQUIRED_CALLBACK_FIXTURES,
  OAUTH_CLIENT_REGISTRATION_REJECTION_FIXTURES,
} from "@/api/tests/helpers/oauth-client-registration-fixtures";
import {
  authorizeOAuthClient,
  consentAndExchange,
  exchangeOAuthCode,
  grantOAuthClient,
  readSignedQuery,
  registerOAuthClient,
} from "@/api/tests/helpers/oauth-grant";

beforeAll(async () => {
  await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

/**
 * Better Auth buckets the registration rate limit per client address
 * (`${ip}|${path}`) and the provider allows a handful per minute, which a
 * census exceeds. Each fixture therefore registers from its own RFC 5737
 * documentation address, which is also what distinct clients do.
 */
let registrationsIssued = 0;
const registerClient = async (body: Record<string, unknown>) => {
  registrationsIssued += 1;
  const startedAt = performance.now();
  const response = await getAuth().handler(
    new Request(getAuthEndpointUrl("oauth2/register"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `198.51.100.${String(registrationsIssued)}`,
      },
      body: JSON.stringify(body),
    }),
  );
  expect(performance.now() - startedAt).toBeLessThan(10_000);
  return response;
};

const registrationResponseSchema = v.looseObject({
  client_id: v.pipe(v.string(), v.minLength(1)),
});

const registrationErrorSchema = v.looseObject({ error: v.string() });

/**
 * RFC 7591 §3.2.1: the response restates the metadata the server accepted, so
 * a client-supplied value here must survive registration unaltered. `scope` is
 * excluded because the response carries the operator-approved capability set
 * rather than the requested subset, and `contacts` because an empty array is
 * normalized away.
 */
const ECHOED_METADATA_FIELDS: ReadonlySet<string> = new Set([
  "application_type",
  "client_name",
  "client_uri",
  "grant_types",
  "logo_uri",
  "policy_uri",
  "redirect_uris",
  "response_types",
  "software_id",
  "software_version",
  "token_endpoint_auth_method",
  "tos_uri",
]);

const acceptanceCases = Object.values(OAUTH_CLIENT_REGISTRATION_FIXTURES).map(
  (fixture) => [`${fixture.client} [${fixture.origin}]`, fixture] as const,
);

describe("OAuth dynamic client registration", () => {
  test("requires a session for consent details", async () => {
    const response = await getAuth().handler(
      new Request(
        `${getAuthEndpointUrl("oauth2/consent-info")}?client_id=example-client`,
      ),
    );
    expect(response.status).toBe(401);
  });

  test.each(
    Object.entries(OAUTH_REGISTRATION_SCOPE_POLICY)
      .filter(([, policy]) => policy === "elevated")
      .map(([scope]) => scope),
  )("registers the configured capability subset for %s", async (scope) => {
    const response = await registerClient({
      redirect_uris: ["https://connector.example/callback"],
      scope,
    });
    expect(response.status).toBe(201);
    const registered = v.parse(
      v.looseObject({ scope: v.string() }),
      await response.json(),
    );
    expect(registered.scope.split(" ").toSorted()).toEqual(
      OPEN_REGISTRATION_SCOPES.toSorted(),
    );
  });

  test("persists open registration capabilities and supplies consent details", async () => {
    const response = await registerClient({
      client_name: "Example connector",
      redirect_uris: ["https://connector.example/callback"],
    });
    expect(response.status).toBe(201);
    const registered = v.parse(
      v.looseObject({ client_id: v.string(), scope: v.string() }),
      await response.json(),
    );
    expect(registered.scope.split(" ").toSorted()).toEqual(
      OPEN_REGISTRATION_SCOPES.toSorted(),
    );
    const context = await getAuth().$context;
    const stored = await context.adapter.findOne<
      SchemaClient<readonly string[]>
    >({
      model: "oauthClient",
      where: [{ field: "clientId", value: registered.client_id }],
    });
    expect(stored?.scopes?.toSorted()).toEqual(
      OPEN_REGISTRATION_SCOPES.toSorted(),
    );
    const browser = await signInHuman("consent-details@example.test");
    const details = await getAuth().handler(
      new Request(
        `${getAuthEndpointUrl("oauth2/consent-info")}?client_id=${registered.client_id}`,
        { headers: browser.headers() },
      ),
    );
    expect(details.status).toBe(200);
    expect(details.headers.get(CACHE_CONTROL_HEADER)).toBe(
      PRIVATE_CACHE_CONTROL,
    );
    expect(await details.json()).toEqual({
      client_name: "Example connector",
      redirectHosts: ["connector.example"],
      clientIdHost: null,
      unverified: true,
    });
  });

  test.each(acceptanceCases)("registers %s", async (_label, fixture) => {
    const response = await registerClient(fixture.body);

    expect(
      response.status,
      `${fixture.client} was refused: ${await response.clone().text()}`,
    ).toBe(201);

    const registered = v.parse(
      registrationResponseSchema,
      await response.json(),
    );

    const echoed = Object.entries(fixture.body).filter(([field]) =>
      ECHOED_METADATA_FIELDS.has(field),
    );
    // A fixture that echoes nothing would assert nothing.
    expect(echoed.length).toBeGreaterThan(0);

    for (const [field, sent] of echoed) {
      expect(registered[field], `${fixture.client} altered ${field}`).toEqual(
        sent,
      );
    }
  });

  test.each(
    [
      ...Object.values(OAUTH_CLIENT_REGISTRATION_FIXTURES).filter(
        (fixture) => fixture.origin === "captured",
      ),
      ...Object.values(OAUTH_REQUIRED_CALLBACK_FIXTURES),
    ].flatMap((fixture) =>
      ["GET", "POST"].map(
        (method) => [fixture.client, method, fixture] as const,
      ),
    ),
  )(
    "registers and authorizes %s using %s",
    async (_client, method, fixture) => {
      const response = await registerClient(fixture.body);
      expect(response.status).toBe(201);
      const registered = v.parse(
        registrationResponseSchema,
        await response.json(),
      );
      const redirectUris = v.parse(
        v.array(v.string()),
        fixture.body.redirect_uris,
      );
      const redirectUri = v.parse(v.string(), redirectUris.at(0));
      const requestedRedirect = new URL(redirectUri);
      if (requestedRedirect.protocol === "http:") {
        requestedRedirect.port = "62000";
      }
      const browser = await signInHuman(
        `consent-${String(registrationsIssued)}@example.test`,
      );
      const organization = await getAuth().api.createOrganization({
        body: { name: "Consent flow", slug: `consent-${Bun.randomUUIDv7()}` },
        headers: browser.headers(),
      });
      await browser.setActiveOrganization(organization.id);
      const requestedScope: unknown =
        "scope" in fixture.body ? fixture.body.scope : undefined;
      const query = new URLSearchParams({
        client_id: registered.client_id,
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        redirect_uri: requestedRedirect.toString(),
        response_type: "code",
        scope:
          typeof requestedScope === "string"
            ? requestedScope
            : MCP_OAUTH_SCOPES.join(" "),
      });
      registrationsIssued += 1;
      const authorizeUrl = getAuthEndpointUrl("oauth2/authorize");
      const authorized = await getAuth().handler(
        new Request(
          method === "GET"
            ? `${authorizeUrl}?${query.toString()}`
            : authorizeUrl,
          {
            method,
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              cookie: browser.cookieHeader(),
              "x-forwarded-for": `198.51.100.${String(registrationsIssued)}`,
            },
            ...(method === "POST" ? { body: query.toString() } : {}),
          },
        ),
      );
      expect(authorized.status).toBe(302);
      const location = v.parse(v.string(), authorized.headers.get("location"));
      expect(new URL(location).pathname).toBe("/consent");
      expect(location).toContain("oauth_query=");
      const signed = readSignedQuery(new URL(location));
      expect(new URLSearchParams(signed).get("redirect_uri")).toBe(
        requestedRedirect.toString(),
      );
      const consentScope = new URLSearchParams(signed).get("scope");
      const expected = query
        .get("scope")
        ?.split(" ")
        .filter((scope) => OPEN_REGISTRATION_SCOPES.includes(scope));
      expect(consentScope?.split(" ")).toEqual(expected);
    },
  );

  test("shows and grants the registered capability subset", async () => {
    const browser = await signInHuman("consent-flow@example.test");
    const organization = await getAuth().api.createOrganization({
      body: { name: "Consent flow", slug: `consent-${Bun.randomUUIDv7()}` },
      headers: browser.headers(),
    });
    await browser.setActiveOrganization(organization.id);
    const client = await registerOAuthClient();
    const { codeVerifier, redirect: consentPage } = await authorizeOAuthClient(
      browser,
      client,
    );
    expect(consentPage.pathname).toBe("/consent");
    const expectedResourceScopes = MCP_DEFAULT_RESOURCE_SCOPES.filter(
      (scope) => OAUTH_REGISTRATION_SCOPE_POLICY[scope] === "open",
    ).toSorted();
    const expectedConsentScopes = [
      ...expectedResourceScopes,
      "offline_access",
    ].toSorted();
    const shownScope = v.parse(
      v.string(),
      new URLSearchParams(readSignedQuery(consentPage)).get("scope"),
    );
    expect(shownScope.split(" ").toSorted()).toEqual(expectedConsentScopes);
    const grant = await consentAndExchange({
      browser,
      client,
      codeVerifier,
      consentPage,
    });
    expect(grant.scope.split(" ").toSorted()).toEqual(expectedConsentScopes);
  });

  test("authorizes an earlier registration with the open capability subset", async () => {
    const response = await registerClient({
      client_name: "Earlier connector",
      redirect_uris: ["https://earlier.example/callback"],
    });
    expect(response.status).toBe(201);
    const registered = v.parse(
      v.looseObject({ client_id: v.string() }),
      await response.json(),
    );
    // A registration stored before the capability policy kept every scope.
    const context = await getAuth().$context;
    await context.adapter.update({
      model: "oauthClient",
      where: [{ field: "clientId", value: registered.client_id }],
      update: { scopes: [...MCP_OAUTH_SCOPES] },
    });
    const browser = await signInHuman("earlier-registration@example.test");
    const organization = await getAuth().api.createOrganization({
      body: { name: "Consent flow", slug: `consent-${Bun.randomUUIDv7()}` },
      headers: browser.headers(),
    });
    await browser.setActiveOrganization(organization.id);
    registrationsIssued += 1;
    const query = new URLSearchParams({
      client_id: registered.client_id,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      redirect_uri: "https://earlier.example/callback",
      response_type: "code",
      scope: MCP_OAUTH_SCOPES.join(" "),
    });
    const authorized = await getAuth().handler(
      new Request(
        `${getAuthEndpointUrl("oauth2/authorize")}?${query.toString()}`,
        {
          headers: {
            cookie: browser.cookieHeader(),
            "x-forwarded-for": `198.51.100.${String(registrationsIssued)}`,
          },
        },
      ),
    );
    expect(authorized.status).toBe(302);
    const location = new URL(
      v.parse(v.string(), authorized.headers.get("location")),
    );
    expect(location.pathname).toBe("/consent");
    const consentScope = new URLSearchParams(readSignedQuery(location)).get(
      "scope",
    );
    expect(consentScope?.split(" ")).toEqual(
      MCP_OAUTH_SCOPES.filter((scope) =>
        OPEN_REGISTRATION_SCOPES.includes(scope),
      ),
    );
  });

  test("treats an empty contacts array as absent", async () => {
    const { body } = OAUTH_CLIENT_REGISTRATION_FIXTURES.emptyContacts;
    // The fixture must actually carry the empty array, or this passes without
    // ever reaching the normalization.
    expect(body.contacts).toEqual([]);

    const response = await registerClient(body);

    expect(response.status).toBe(201);
    const registered = v.parse(
      registrationResponseSchema,
      await response.json(),
    );
    expect(registered).not.toHaveProperty("contacts");
  });

  test("ignores unknown top-level client metadata", async () => {
    const { body } = OAUTH_CLIENT_REGISTRATION_FIXTURES.unknownMetadataFields;
    const unknownFields = ["x-vendor-deployment", "unknown_extension_field"];
    for (const field of unknownFields) {
      expect(body).toHaveProperty(field);
    }

    const response = await registerClient(body);

    expect(response.status).toBe(201);
    const registered = v.parse(
      registrationResponseSchema,
      await response.json(),
    );
    for (const field of unknownFields) {
      expect(registered).not.toHaveProperty(field);
    }
    // Registered-but-unmodelled metadata is kept, so "ignore the unknown" did
    // not become "drop everything the core schema does not map".
    expect(registered["software_id"]).toBe(body.software_id);
    expect(registered["software_version"]).toBe(body.software_version);
  });

  test("issues a client secret to a registrar that states no auth method", async () => {
    const { body } =
      OAUTH_CLIENT_REGISTRATION_FIXTURES.microsoftEnterpriseTokenStore;
    // The default only applies while the request stays silent about it.
    expect(body).not.toHaveProperty("token_endpoint_auth_method");

    const response = await registerClient(body);

    expect(response.status).toBe(201);
    const registered = v.parse(
      v.looseObject({
        client_id: v.pipe(v.string(), v.minLength(1)),
        client_secret: v.pipe(v.string(), v.minLength(1)),
        token_endpoint_auth_method: v.literal("client_secret_basic"),
      }),
      await response.json(),
    );
    expect(registered.token_endpoint_auth_method).toBe("client_secret_basic");
  });

  test.each(
    Object.values(OAUTH_CLIENT_REGISTRATION_REJECTION_FIXTURES).map(
      (fixture) => [fixture.client, fixture] as const,
    ),
  )("refuses %s", async (_label, fixture) => {
    const response = await registerClient(fixture.body);

    expect(response.status).toBe(400);
    const refused = v.parse(registrationErrorSchema, await response.json());
    expect(refused.error).toBe(fixture.error);
  });
});

describe("OAuth capability policy", () => {
  const openSubset = (scopes: readonly string[]) =>
    scopes
      .filter((scope) => OPEN_REGISTRATION_SCOPES.includes(scope))
      .toSorted();

  const elevatedScopes = Object.entries(OAUTH_REGISTRATION_SCOPE_POLICY)
    .filter(([, policy]) => policy === "elevated")
    .map(([scope]) => scope);

  const expectOpenGrant = (scope: string) => {
    const granted = scope.split(" ");
    expect(granted).toContain("stella:read");
    for (const elevated of elevatedScopes) {
      expect(granted).not.toContain(elevated);
    }
  };

  /** A registration whose stored scope list predates the capability policy. */
  const registerWithEveryScope = async (email: string) => {
    registrationsIssued += 1;
    const client = await registerOAuthClient(
      `203.0.113.${String(registrationsIssued)}`,
    );
    const context = await getAuth().$context;
    await context.adapter.update({
      model: "oauthClient",
      where: [{ field: "clientId", value: client.clientId }],
      update: { scopes: [...MCP_OAUTH_SCOPES] },
    });
    const browser = await signInHuman(email);
    const organization = await getAuth().api.createOrganization({
      body: { name: "Consent flow", slug: `consent-${Bun.randomUUIDv7()}` },
      headers: browser.headers(),
    });
    await browser.setActiveOrganization(organization.id);
    return { browser, client, context };
  };

  test("applies the open capability subset when a request names no scope", async () => {
    const { browser, client } = await registerWithEveryScope(
      "no-scope@example.test",
    );
    const { codeVerifier, redirect: consentPage } = await authorizeOAuthClient(
      browser,
      client,
      null,
    );
    expect(consentPage.pathname).toBe("/consent");
    const shownScope = v.parse(
      v.string(),
      new URLSearchParams(readSignedQuery(consentPage)).get("scope"),
    );
    expect(shownScope.split(" ").toSorted()).toEqual(
      openSubset(MCP_OAUTH_SCOPES),
    );
    const grant = await consentAndExchange({
      browser,
      client,
      codeVerifier,
      consentPage,
    });
    expectOpenGrant(grant.scope);
  });

  test("applies the open capability subset over an earlier wider consent", async () => {
    const { browser, client, context } = await registerWithEveryScope(
      "earlier-consent@example.test",
    );
    await grantOAuthClient(browser, client);
    await context.adapter.update({
      model: "oauthConsent",
      where: [{ field: "clientId", value: client.clientId }],
      update: { scopes: [...MCP_OAUTH_SCOPES] },
    });
    const { codeVerifier, redirect } = await authorizeOAuthClient(
      browser,
      client,
      null,
    );
    // The earlier consent covers the request, so no consent page is shown.
    expect(redirect.pathname).not.toBe("/consent");
    expect(redirect.searchParams.get("code")).toEqual(expect.any(String));
    const grant = await exchangeOAuthCode({ client, codeVerifier, redirect });
    expectOpenGrant(grant.scope);
  });

  test("does not serve client creation to a signed-in user", async () => {
    const browser = await signInHuman("client-creation@example.test");
    const response = await getAuth().handler(
      new Request(getAuthEndpointUrl("oauth2/create-client"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: browser.cookieHeader(),
        },
        body: JSON.stringify({
          redirect_uris: ["https://connector.example/callback"],
          scope: "stella:read stella:admin_write",
        }),
      }),
    );
    expect(response.status).toBe(404);
  });

  test("does not serve client updates to the client's owner", async () => {
    const browser = await signInHuman("client-update@example.test");
    const created = await getAuth().api.createOAuthClient({
      headers: browser.headers(),
      body: {
        redirect_uris: ["https://connector.example/callback"],
        scope: "stella:read",
      },
    });
    const response = await getAuth().handler(
      new Request(getAuthEndpointUrl("oauth2/update-client"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: browser.cookieHeader(),
        },
        body: JSON.stringify({
          client_id: created.client_id,
          update: { scope: "stella:read stella:admin_write" },
        }),
      }),
    );
    expect(response.status).toBe(404);
    const context = await getAuth().$context;
    const stored = await context.adapter.findOne<
      SchemaClient<readonly string[]>
    >({
      model: "oauthClient",
      where: [{ field: "clientId", value: created.client_id }],
    });
    expect(stored?.scopes).toEqual(["stella:read"]);
  });

  test("every provider endpoint has a decided policy", async () => {
    const auth = getAuth();
    const endpoints = Object.values(auth.api).flatMap((endpoint) => {
      const path: unknown = Reflect.get(endpoint, "path");
      return typeof path === "string" && path.includes("oauth2")
        ? [{ path, endpoint }]
        : [];
    });
    expect([...new Set(endpoints.map(({ path }) => path))].toSorted()).toEqual(
      Object.keys(OAUTH_ENDPOINT_POLICY).toSorted(),
    );
    const policies: Record<string, string> = OAUTH_ENDPOINT_POLICY;
    for (const { path, endpoint } of endpoints) {
      const policy = policies[path];
      if (policy === "disabled") {
        expect(auth.options.disabledPaths).toContain(path);
        const response = await auth.handler(
          new Request(getAuthEndpointUrl(path.slice(1)), { method: "POST" }),
        );
        expect(response.status, path).toBe(404);
      }
      if (policy === "server-only") {
        const options: unknown = Reflect.get(endpoint, "options");
        expect(options, path).toMatchObject({
          metadata: { SERVER_ONLY: true },
        });
      }
      if (policy === "scope-policy") {
        expect(OAUTH_SCOPE_POLICY_PATHS.has(path), path).toBe(true);
      }
    }
    expect([...OAUTH_SCOPE_POLICY_PATHS].toSorted()).toEqual([
      "/oauth2/authorize",
      "/oauth2/register",
    ]);
  });
});

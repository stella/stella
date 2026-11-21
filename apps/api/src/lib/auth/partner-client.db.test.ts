import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import * as v from "valibot";

import { sha256Base64Url } from "@stll/sha256/bun";

import { oauthClient, oauthClientResource } from "@/api/db/auth-schema";
import {
  changePartnerOAuthClient,
  changeServiceOAuthClient,
  createPartnerOAuthClient,
  rootDb,
} from "@/api/db/root";
import { systemAuditRuns } from "@/api/db/schema";
import { getAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip";
import { OPEN_REGISTRATION_SCOPES } from "@/api/lib/db/oauth-scope-policy";
import {
  mintPartnerClientSecret,
  PARTNER_CLIENT_SECRET_SHA256_PATTERN,
  PARTNER_CLIENT_TYPE,
} from "@/api/lib/db/partner-client-contract";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import { readSignedQuery } from "@/api/tests/helpers/oauth-grant";

beforeAll(initAgentAuthTestDb);
afterAll(releaseAgentAuthTestDb);

const PARTNER_REDIRECT = "https://consent.partner.example/redirect";
const AUDIT_ACTOR = "system:partner-client-operator";

const create = async () => {
  const { clientSecret, clientSecretSha256 } = mintPartnerClientSecret();
  const created = await createPartnerOAuthClient({
    name: "Example partner assistant",
    redirectUris: [PARTNER_REDIRECT],
    mcpResourceUrl: getMcpResourceUrl(),
    clientSecretSha256,
  });
  // The server hands back nothing secret: only the id it assigned.
  expect(created).toEqual({ clientId: expect.any(String) });
  return { clientId: created.clientId, clientSecret };
};

const storedClient = async (clientId: string) =>
  (
    await rootDb
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId))
  ).at(0);

let requests = 0;
const clientAddress = () => {
  requests += 1;
  return `203.0.113.${String(requests)}`;
};

const tokenSchema = v.looseObject({
  access_token: v.string(),
  refresh_token: v.string(),
  scope: v.string(),
});

type PartnerCredentials = { clientId: string; clientSecret: string };

/** RFC 7636 appendix B: a verifier and its S256 challenge. */
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/**
 * The flow a generic OAuth connector runs: no `resource`, PKCE S256, and the
 * client secret in an HTTP Basic header.
 */
const authorizeAndExchange = async ({
  clientId,
  clientSecret,
}: PartnerCredentials) => {
  const browser = await signInHuman(
    `partner-${Bun.randomUUIDv7()}@example.test`,
  );
  const organization = await getAuth().api.createOrganization({
    body: { name: "Partner", slug: `partner-${Bun.randomUUIDv7()}` },
    headers: browser.headers(),
  });
  await browser.setActiveOrganization(organization.id);
  const query = new URLSearchParams({
    client_id: clientId,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    redirect_uri: PARTNER_REDIRECT,
    response_type: "code",
    scope: "openid offline_access stella:read stella:search",
    state: Bun.randomUUIDv7(),
  });
  const authorized = await getAuth().handler(
    new Request(
      `${getAuthEndpointUrl("oauth2/authorize")}?${query.toString()}`,
      {
        headers: {
          cookie: browser.cookieHeader(),
          [AUTH_CLIENT_ADDRESS_HEADER]: clientAddress(),
        },
      },
    ),
  );
  expect(authorized.status).toBe(302);
  const consentPage = new URL(
    v.parse(v.string(), authorized.headers.get("location")),
  );
  expect(consentPage.pathname, consentPage.search).toBe("/consent");
  const signed = readSignedQuery(consentPage);
  expect(new URLSearchParams(signed).get("resource")).toBe(getMcpResourceUrl());
  const consented = v.parse(
    v.looseObject({ url: v.string() }),
    await (
      await getAuth().handler(
        new Request(getAuthEndpointUrl("oauth2/consent"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: browser.cookieHeader(),
          },
          body: JSON.stringify({ accept: true, oauth_query: signed }),
        }),
      )
    ).json(),
  );
  const code = v.parse(
    v.string(),
    new URL(consented.url).searchParams.get("code"),
  );
  const exchanged = await getAuth().handler(
    new Request(getAuthEndpointUrl("oauth2/token"), {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
        [AUTH_CLIENT_ADDRESS_HEADER]: clientAddress(),
      },
      body: new URLSearchParams({
        code,
        code_verifier: CODE_VERIFIER,
        grant_type: "authorization_code",
        redirect_uri: PARTNER_REDIRECT,
      }),
    }),
  );
  return exchanged;
};

const refresh = async (
  { clientId, clientSecret }: PartnerCredentials,
  refreshToken: string,
) =>
  await getAuth().handler(
    new Request(getAuthEndpointUrl("oauth2/token"), {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
        [AUTH_CLIENT_ADDRESS_HEADER]: clientAddress(),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    }),
  );

const auditCounts = async () =>
  (
    await rootDb
      .select({ counts: systemAuditRuns.counts })
      .from(systemAuditRuns)
      .where(eq(systemAuditRuns.actor, AUDIT_ACTOR))
  ).map(({ counts }) => counts);

describe("partner OAuth clients", () => {
  test("the digest argument takes a minted secret's digest and refuses the secret itself", () => {
    const { clientSecret, clientSecretSha256 } = mintPartnerClientSecret();
    expect(clientSecretSha256).toBe(sha256Base64Url(clientSecret));
    expect(PARTNER_CLIENT_SECRET_SHA256_PATTERN.test(clientSecretSha256)).toBe(
      true,
    );
    expect(PARTNER_CLIENT_SECRET_SHA256_PATTERN.test(clientSecret)).toBe(false);
  });

  test("create stores a confidential client linked to the MCP resource only", async () => {
    const before = (await auditCounts()).length;
    const { clientId, clientSecret } = await create();

    const stored = await storedClient(clientId);
    expect(stored).toMatchObject({
      type: PARTNER_CLIENT_TYPE,
      registrationOrigin: "managed",
      public: false,
      requirePKCE: true,
      disabled: false,
      skipConsent: false,
      tokenEndpointAuthMethod: "client_secret_basic",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      redirectUris: [PARTNER_REDIRECT],
      clientSecret: sha256Base64Url(clientSecret),
    });
    expect(stored?.scopes?.toSorted()).toEqual(
      OPEN_REGISTRATION_SCOPES.toSorted(),
    );
    expect(
      await rootDb
        .select({ resourceId: oauthClientResource.resourceId })
        .from(oauthClientResource)
        .where(eq(oauthClientResource.clientId, clientId)),
    ).toEqual([{ resourceId: getMcpResourceUrl() }]);
    const audits = await auditCounts();
    expect(audits.length).toBe(before + 1);
    expect(audits.at(-1)).toEqual({ created: 1, rotated: 0, disabled: 0 });
  });

  test("authorization without PKCE is refused", async () => {
    const { clientId } = await create();
    const browser = await signInHuman(
      `partner-${Bun.randomUUIDv7()}@example.test`,
    );
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: PARTNER_REDIRECT,
      response_type: "code",
      scope: "openid stella:read",
    });
    const refused = await getAuth().handler(
      new Request(
        `${getAuthEndpointUrl("oauth2/authorize")}?${query.toString()}`,
        {
          headers: {
            cookie: browser.cookieHeader(),
            [AUTH_CLIENT_ADDRESS_HEADER]: clientAddress(),
          },
        },
      ),
    );
    const location = new URL(
      v.parse(v.string(), refused.headers.get("location")),
    );
    expect(location.origin + location.pathname).toBe(PARTNER_REDIRECT);
    expect(location.searchParams.get("error")).toBe("invalid_request");
  });

  test("a user consents and the token targets the MCP resource without a resource parameter", async () => {
    const credentials = await create();
    const response = await authorizeAndExchange(credentials);

    expect(response.status).toBe(200);
    const tokens = v.parse(tokenSchema, await response.json());
    // `openid` adds the userinfo audience next to the MCP resource.
    expect([decodeJwt(tokens.access_token).aud].flat()).toContain(
      getMcpResourceUrl(),
    );
    for (const scope of tokens.scope.split(" ")) {
      expect(OPEN_REGISTRATION_SCOPES).toContain(scope);
    }
  });

  test("rotation replaces the secret: the old one can no longer refresh", async () => {
    const credentials = await create();
    const tokens = v.parse(
      tokenSchema,
      await (await authorizeAndExchange(credentials)).json(),
    );
    const { clientSecret: newSecret, clientSecretSha256 } =
      mintPartnerClientSecret();
    const rotated = await changePartnerOAuthClient({
      clientId: credentials.clientId,
      operation: "rotate",
      clientSecretSha256,
    });
    expect(rotated).toEqual({ clientId: credentials.clientId });

    expect(newSecret).not.toBe(credentials.clientSecret);
    expect((await refresh(credentials, tokens.refresh_token)).status).toBe(401);
    expect(
      (
        await refresh(
          { clientId: credentials.clientId, clientSecret: newSecret },
          tokens.refresh_token,
        )
      ).status,
    ).toBe(200);
    expect((await auditCounts()).at(-1)).toEqual({
      created: 0,
      rotated: 1,
      disabled: 0,
    });
  });

  test("disabling refuses new tokens and further changes", async () => {
    const credentials = await create();
    const tokens = v.parse(
      tokenSchema,
      await (await authorizeAndExchange(credentials)).json(),
    );
    await changePartnerOAuthClient({
      clientId: credentials.clientId,
      operation: "disable",
    });

    expect((await storedClient(credentials.clientId))?.disabled).toBe(true);
    expect(
      (await refresh(credentials, tokens.refresh_token)).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await auditCounts()).at(-1)).toEqual({
      created: 0,
      rotated: 0,
      disabled: 1,
    });
    const again = await Result.tryPromise(
      async () =>
        await changePartnerOAuthClient({
          clientId: credentials.clientId,
          operation: "rotate",
          clientSecretSha256: mintPartnerClientSecret().clientSecretSha256,
        }),
    );
    expect(Result.isError(again)).toBe(true);
  });

  test("a self-registered client that names no resource gets none", async () => {
    const registered = v.parse(
      v.looseObject({ client_id: v.string() }),
      await (
        await getAuth().handler(
          new Request(getAuthEndpointUrl("oauth2/register"), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [AUTH_CLIENT_ADDRESS_HEADER]: clientAddress(),
            },
            body: JSON.stringify({
              client_name: "Self-registered client",
              redirect_uris: [PARTNER_REDIRECT],
              token_endpoint_auth_method: "none",
            }),
          }),
        )
      ).json(),
    );
    const browser = await signInHuman(
      `partner-${Bun.randomUUIDv7()}@example.test`,
    );
    const organization = await getAuth().api.createOrganization({
      body: { name: "Partner", slug: `partner-${Bun.randomUUIDv7()}` },
      headers: browser.headers(),
    });
    await browser.setActiveOrganization(organization.id);
    const query = new URLSearchParams({
      client_id: registered.client_id,
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
      redirect_uri: PARTNER_REDIRECT,
      response_type: "code",
      scope: "openid stella:read",
    });
    const authorized = await getAuth().handler(
      new Request(
        `${getAuthEndpointUrl("oauth2/authorize")}?${query.toString()}`,
        {
          headers: {
            cookie: browser.cookieHeader(),
            [AUTH_CLIENT_ADDRESS_HEADER]: clientAddress(),
          },
        },
      ),
    );
    const consentPage = new URL(
      v.parse(v.string(), authorized.headers.get("location")),
    );
    expect(consentPage.pathname).toBe("/consent");
    expect(
      new URLSearchParams(readSignedQuery(consentPage)).get("resource"),
    ).toBeNull();
  });

  test("operators cannot change a client that is not a partner client", async () => {
    const registered = v.parse(
      v.looseObject({ client_id: v.string() }),
      await (
        await getAuth().handler(
          new Request(getAuthEndpointUrl("oauth2/register"), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [AUTH_CLIENT_ADDRESS_HEADER]: clientAddress(),
            },
            body: JSON.stringify({
              client_name: "Self-registered client",
              redirect_uris: ["https://client.example/callback"],
              token_endpoint_auth_method: "none",
            }),
          }),
        )
      ).json(),
    );
    const before = await storedClient(registered.client_id);

    for (const operation of ["rotate", "disable"] as const) {
      const changed = await Result.tryPromise(
        async () =>
          await changePartnerOAuthClient(
            operation === "rotate"
              ? {
                  clientId: registered.client_id,
                  operation,
                  clientSecretSha256:
                    mintPartnerClientSecret().clientSecretSha256,
                }
              : { clientId: registered.client_id, operation },
          ),
      );
      expect(Result.isError(changed)).toBe(true);
    }
    expect(await storedClient(registered.client_id)).toEqual(before);

    const partner = await create();
    const asService = await Result.tryPromise(
      async () =>
        await changeServiceOAuthClient({
          clientId: partner.clientId,
          operation: "disable",
          operatorUid: 12_345,
        }),
    );
    expect(Result.isError(asService)).toBe(true);
    expect((await storedClient(partner.clientId))?.disabled).toBe(false);
  });
});

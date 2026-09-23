import { panic } from "better-result";
import * as v from "valibot";

import { MCP_DEFAULT_RESOURCE_SCOPES } from "@stll/api-contract";

import { getAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth-paths";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";

// Drives the OAuth provider the way a hosted MCP connector does: dynamic
// registration, the browser's authorize and consent steps, and the code
// exchange, all through the real Better Auth handler and database.

const REDIRECT_URI = "https://connector.example.test/oauth/callback";
const GRANTED_SCOPES = [...MCP_DEFAULT_RESOURCE_SCOPES, "offline_access"];

export type RegisteredOAuthClient = {
  clientId: string;
  clientSecret: string;
};

export type OAuthGrant = {
  accessToken: string;
  refreshToken: string;
};

const registrationSchema = v.looseObject({
  client_id: v.pipe(v.string(), v.minLength(1)),
  client_secret: v.pipe(v.string(), v.minLength(1)),
});
const redirectSchema = v.looseObject({ url: v.string() });

const tokenSchema = v.looseObject({
  access_token: v.pipe(v.string(), v.minLength(1)),
  refresh_token: v.pipe(v.string(), v.minLength(1)),
});
const introspectionSchema = v.looseObject({ active: v.boolean() });

// Each request gets its own documentation address (RFC 5737) so the provider's
// per-address rate limits never couple unrelated steps or suites.
let requestsIssued = 0;
const nextClientAddress = () => {
  requestsIssued += 1;
  return `198.51.${String(100 + Math.floor(requestsIssued / 250))}.${String((requestsIssued % 250) + 1)}`;
};

const formRequest = (path: string, body: Record<string, string>) =>
  new Request(getAuthEndpointUrl(path), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": nextClientAddress(),
    },
    body: new URLSearchParams(body),
  });

const readJson = async <TSchema extends v.GenericSchema>(
  response: Response,
  schema: TSchema,
): Promise<v.InferOutput<TSchema>> => {
  if (!response.ok) {
    panic(
      `OAuth step failed with ${String(response.status)}: ${await response.text()}`,
    );
  }
  return v.parse(schema, await response.json());
};

/** Read the provider's JSON redirect answer to a browser step. */
export const readOAuthRedirect = async (response: Response): Promise<URL> =>
  new URL((await readJson(response, redirectSchema)).url);

/** Register a confidential web client the way a hosted connector does. */
export const registerOAuthClient = async (): Promise<RegisteredOAuthClient> => {
  const response = await getAuth().handler(
    new Request(getAuthEndpointUrl("oauth2/register"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": nextClientAddress(),
      },
      body: JSON.stringify({
        application_type: "web",
        client_name: "Example hosted connector",
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [REDIRECT_URI],
        response_types: ["code"],
        scope: GRANTED_SCOPES.join(" "),
        token_endpoint_auth_method: "client_secret_post",
      }),
    }),
  );
  const registered = await readJson(response, registrationSchema);
  return {
    clientId: registered.client_id,
    clientSecret: registered.client_secret,
  };
};

const toCodeChallenge = async (verifier: string) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");

const readCode = (redirectUrl: string): string =>
  new URL(redirectUrl).searchParams.get("code") ??
  panic(`consent redirect carried no code: ${redirectUrl}`);

/** The web page the provider sends a browser to when consent is needed. */
export const OAUTH_CONSENT_PAGE_PATH = "/consent";

/**
 * The web page where a user in more than one organization picks the one a
 * grant is scoped to, before consent.
 */
export const OAUTH_ORGANIZATION_PAGE_PATH = "/auth/organization";

/**
 * The signed copy of the authorization request the provider hands a web page
 * in the fragment; the page posts it back unchanged to continue.
 */
export const readSignedQuery = (page: URL): string =>
  new URLSearchParams(page.hash.slice(1)).get("oauth_query") ??
  panic(`${page.pathname} redirect carried no signed query`);

type AuthorizationStart = {
  codeVerifier: string;
  /** Where the provider sends the browser next. */
  redirect: URL;
};

/** Start an authorization request as the signed-in browser. */
export const authorizeOAuthClient = async (
  browser: HumanBrowser,
  client: RegisteredOAuthClient,
): Promise<AuthorizationStart> => {
  const codeVerifier = `${Bun.randomUUIDv7()}${Bun.randomUUIDv7()}`;
  const authorizeUrl = new URL(getAuthEndpointUrl("oauth2/authorize"));
  authorizeUrl.search = new URLSearchParams({
    client_id: client.clientId,
    code_challenge: await toCodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    resource: getMcpResourceUrl(),
    response_type: "code",
    scope: GRANTED_SCOPES.join(" "),
    state: Bun.randomUUIDv7(),
  }).toString();

  const authorized = await readJson(
    await getAuth().handler(
      new Request(authorizeUrl.href, {
        headers: { accept: "application/json", cookie: browser.cookieHeader() },
      }),
    ),
    redirectSchema,
  );
  return { codeVerifier, redirect: new URL(authorized.url) };
};

type ConsentAndExchangeOptions = {
  browser: HumanBrowser;
  client: RegisteredOAuthClient;
  codeVerifier: string;
  consentPage: URL;
};

/** Accept on the consent page the provider sent the browser to, then exchange the code. */
export const consentAndExchange = async ({
  browser,
  client,
  codeVerifier,
  consentPage,
}: ConsentAndExchangeOptions): Promise<OAuthGrant> => {
  const auth = getAuth();
  if (consentPage.pathname !== OAUTH_CONSENT_PAGE_PATH) {
    panic(`expected the consent page, got ${consentPage.pathname}`);
  }
  const signedQuery = readSignedQuery(consentPage);
  const consented = await readJson(
    await auth.handler(
      new Request(getAuthEndpointUrl("oauth2/consent"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: browser.cookieHeader(),
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: signedQuery,
        }),
      }),
    ),
    redirectSchema,
  );

  const tokens = await readJson(
    await auth.handler(
      formRequest("oauth2/token", {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code: readCode(consented.url),
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        resource: getMcpResourceUrl(),
      }),
    ),
    tokenSchema,
  );
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
  };
};

/**
 * Authorize and consent as the signed-in browser, then exchange the code.
 * The consent is scoped to the browser's active organization.
 */
export const grantOAuthClient = async (
  browser: HumanBrowser,
  client: RegisteredOAuthClient,
): Promise<OAuthGrant> => {
  const { codeVerifier, redirect: consentPage } = await authorizeOAuthClient(
    browser,
    client,
  );
  return await consentAndExchange({
    browser,
    client,
    codeVerifier,
    consentPage,
  });
};

type IntrospectOAuthTokenOptions = {
  client: RegisteredOAuthClient;
  token: string;
  tokenTypeHint: "access_token" | "refresh_token";
};

/**
 * Whether the provider still considers a token live (RFC 7662). A token the
 * provider no longer knows at all is reported as inactive too.
 */
export const isOAuthTokenActive = async ({
  client,
  token,
  tokenTypeHint,
}: IntrospectOAuthTokenOptions): Promise<boolean> => {
  const response = await getAuth().handler(
    formRequest("oauth2/introspect", {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      token,
      token_type_hint: tokenTypeHint,
    }),
  );
  if (!response.ok) {
    return false;
  }
  return v.parse(introspectionSchema, await response.json()).active;
};

type RefreshOAuthGrantOptions = {
  client: RegisteredOAuthClient;
  refreshToken: string;
};

/** Present a refresh token at the token endpoint; returns the raw response. */
export const refreshOAuthGrant = async ({
  client,
  refreshToken,
}: RefreshOAuthGrantOptions): Promise<Response> =>
  await getAuth().handler(
    formRequest("oauth2/token", {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      resource: getMcpResourceUrl(),
    }),
  );

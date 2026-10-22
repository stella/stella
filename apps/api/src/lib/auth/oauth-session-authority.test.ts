import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import type { BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  getAuth,
  OAUTH_PROVIDER_SESSION_PATHS,
  resolveAuthoritativeSessionForSensitiveAuthPath,
  SESSION_COOKIE_CACHE_MAX_AGE_SECONDS,
} from "@/api/lib/auth";

const AUTH_BASE_URL = "http://localhost:3001";
const CLIENT_REDIRECT_URI = "https://brief-client.example.test/callback";

type Row = Record<string, unknown>;

const registeredOAuthProviderPlugin = (): BetterAuthPlugin =>
  getAuth().options.plugins.find((plugin) => plugin.id === "oauth-provider") ??
  panic("The OAuth provider plugin is not registered");

const registeredOAuthProviderHttpPaths = () =>
  [
    ...new Set(
      Object.values(registeredOAuthProviderPlugin().endpoints ?? {}).flatMap(
        (endpoint) =>
          typeof endpoint.path === "string" ? [endpoint.path] : [],
      ),
    ),
  ].toSorted();

const responseCookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map(
      (cookie) => cookie.split(";").at(0) ?? panic("Missing response cookie"),
    );

const interactionTarget = (response: Response): URL => {
  const location = response.headers.get("location");
  return location
    ? new URL(location, AUTH_BASE_URL)
    : panic("OAuth authorization did not redirect to an interaction page");
};

const stableInteractionTarget = (response: Response) => {
  const target = interactionTarget(response);
  for (const parameter of ["ba_iat", "exp", "sig"]) {
    target.searchParams.delete(parameter);
  }
  return target.toString();
};

const createFixture = async () => {
  const database: Record<string, Row[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    oauthClient: [],
    oauthConsent: [],
    oauthAccessToken: [],
    oauthAuthorizationCode: [],
    oauthRefreshToken: [],
    oauthResource: [],
    oauthClientResource: [],
  };
  const auth = betterAuth({
    baseURL: AUTH_BASE_URL,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter(database),
    emailAndPassword: { enabled: true },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: SESSION_COOKIE_CACHE_MAX_AGE_SECONDS,
      },
    },
    plugins: [
      oauthProvider({
        loginPage: "/auth/sign-in",
        consentPage: "/oauth/consent",
        disableJwtPlugin: true,
        resourceSeedMode: "none",
        scopes: ["openid"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!ctx.path) {
          return undefined;
        }
        const authoritative =
          await resolveAuthoritativeSessionForSensitiveAuthPath({
            ctx,
            resolveSession: async ({ path }) =>
              await getAuthoritativeSessionFromCtx({ ...ctx, path }),
          });
        if (Result.isError(authoritative)) {
          throw authoritative.error;
        }
        return authoritative.value;
      }),
    },
  });
  const request = async (
    path: string,
    { cookie = "", body }: { cookie?: string; body?: object } = {},
  ) =>
    await auth.handler(
      new Request(`${AUTH_BASE_URL}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie,
          origin: AUTH_BASE_URL,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  const registration = await request("/oauth2/register", {
    body: {
      client_name: "Brief client",
      redirect_uris: [CLIENT_REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "openid",
    },
  });
  if (registration.status !== 201) {
    panic(`OAuth client registration failed: ${await registration.text()}`);
  }
  expect(registration.status).toBe(201);
  const registrationPayload: unknown = await registration.json();
  if (
    typeof registrationPayload !== "object" ||
    registrationPayload === null ||
    !("client_id" in registrationPayload) ||
    typeof registrationPayload.client_id !== "string"
  ) {
    panic("OAuth client registration did not return a client id");
  }
  const clientId = registrationPayload.client_id;
  const signedUp = await request("/sign-up/email", {
    body: {
      email: "authorization-holder@example.test",
      name: "Authorization Holder",
      password: "A secure password 123!",
    },
  });
  expect(signedUp.status).toBe(200);
  let cookie = responseCookies(signedUp).join("; ");
  const refreshed = await request("/get-session?disableCookieCache=true", {
    cookie,
  });
  expect(refreshed.status).toBe(200);
  cookie = [...responseCookies(refreshed), ...responseCookies(signedUp)].join(
    "; ",
  );
  const authorizationPath = () => {
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT_URI,
      response_type: "code",
      scope: "openid",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      state: "authorization-state",
    });
    return `/oauth2/authorize?${query.toString()}`;
  };

  return {
    authorizationPath,
    cookie,
    database,
    request,
    revoke: () => {
      database["session"] = [];
    },
  };
};

describe("OAuth provider endpoints read browser sessions from storage", () => {
  test("every registered OAuth provider HTTP endpoint is classified", () => {
    expect(registeredOAuthProviderHttpPaths()).toEqual(
      Object.keys(OAUTH_PROVIDER_SESSION_PATHS).toSorted(),
    );
  });

  test("authorize treats a revoked cached session like a signed-out visitor", async () => {
    const fixture = await createFixture();
    const signedOut = await fixture.request(fixture.authorizationPath());
    fixture.revoke();

    const revoked = await fixture.request(fixture.authorizationPath(), {
      cookie: fixture.cookie,
    });

    expect(revoked.status).toBe(signedOut.status);
    expect(stableInteractionTarget(revoked)).toBe(
      stableInteractionTarget(signedOut),
    );
    expect(fixture.database["oauthAuthorizationCode"]).toHaveLength(0);
  });

  test("consent refuses a revoked cached session without recording a grant", async () => {
    const fixture = await createFixture();
    const authorization = await fixture.request(fixture.authorizationPath(), {
      cookie: fixture.cookie,
    });
    const authorizationTarget = interactionTarget(authorization);
    expect(authorizationTarget.pathname).toBe("/oauth/consent");
    const oauthQuery = authorizationTarget.search.slice(1);
    fixture.revoke();

    const response = await fixture.request("/oauth2/consent", {
      cookie: fixture.cookie,
      body: { accept: true, oauth_query: oauthQuery },
    });

    expect(response.status).toBe(401);
    expect(fixture.database["oauthConsent"]).toHaveLength(0);
    expect(fixture.database["oauthAuthorizationCode"]).toHaveLength(0);
  });

  test("a live session can record consent and receive an authorization code", async () => {
    const fixture = await createFixture();
    const authorization = await fixture.request(fixture.authorizationPath(), {
      cookie: fixture.cookie,
    });
    const authorizationTarget = interactionTarget(authorization);
    expect(authorizationTarget.pathname).toBe("/oauth/consent");
    const oauthQuery = authorizationTarget.search.slice(1);

    const consent = await fixture.request("/oauth2/consent", {
      cookie: fixture.cookie,
      body: { accept: true, oauth_query: oauthQuery },
    });

    expect(consent.status).toBe(200);
    const payload: unknown = await consent.json();
    expect(payload).toEqual({
      redirect: true,
      url: expect.stringContaining("code="),
    });
    expect(fixture.database["oauthConsent"]).toHaveLength(1);
  });
});

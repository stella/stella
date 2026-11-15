import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import type { BetterAuthPlugin } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { panic } from "better-result";
import { expect, test } from "bun:test";

const AUTH_BASE_URL = "http://localhost:3001";
const CLIENT_REDIRECT_URI = "https://reentry-client.example.test/callback";
/** Bounds the test if authorization re-enters itself; one run is correct. */
const RUN_CEILING = 5;

const responseCookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map(
      (cookie) => cookie.split(";").at(0) ?? panic("Missing response cookie"),
    );

/**
 * Re-issues the caller's session cookie on every authorization response, as a
 * session refresh does, and counts how often the authorization endpoint runs.
 */
const authorizeObserver = () => {
  const observed = { runs: 0 };
  const plugin = {
    id: "authorize-reentry-observer",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/oauth2/authorize",
          handler: createAuthMiddleware(async () => {
            observed.runs += 1;
            if (observed.runs > RUN_CEILING) {
              panic("OAuth authorization re-entered itself");
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === "/oauth2/authorize",
          handler: createAuthMiddleware(async (ctx) => {
            const { name, attributes } = ctx.context.authCookies.sessionToken;
            const value = ctx.getCookie(name);
            if (value) {
              ctx.setCookie(name, value, attributes);
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
  return { observed, plugin };
};

test("an authorization response that re-issues the session cookie runs authorization once", async () => {
  const observer = authorizeObserver();
  const auth = betterAuth({
    baseURL: AUTH_BASE_URL,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter({
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
    }),
    emailAndPassword: { enabled: true },
    plugins: [
      // Registered first so its after hook re-issues the cookie before the
      // provider's post-sign-in continuation inspects the response headers.
      observer.plugin,
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
      client_name: "Re-entry client",
      redirect_uris: [CLIENT_REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "openid",
    },
  });
  expect(registration.status).toBe(201);
  const registered: unknown = await registration.json();
  const clientId =
    typeof registered === "object" &&
    registered !== null &&
    "client_id" in registered &&
    typeof registered.client_id === "string"
      ? registered.client_id
      : panic("OAuth client registration did not return a client id");
  const signedUp = await request("/sign-up/email", {
    body: {
      email: "reentry-holder@example.test",
      name: "Re-entry Holder",
      password: "A secure password 123!",
    },
  });
  expect(signedUp.status).toBe(200);

  const authorized = await request(
    `/oauth2/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT_URI,
      response_type: "code",
      scope: "openid",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      state: "reentry-state",
    }).toString()}`,
    { cookie: responseCookies(signedUp).join("; ") },
  );

  expect(authorized.status).toBe(302);
  expect(observer.observed.runs).toBe(1);
});

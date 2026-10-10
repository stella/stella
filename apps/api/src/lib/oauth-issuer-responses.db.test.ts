import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

import { getAuth } from "@/api/lib/auth";
import {
  getAuthEndpointUrl,
  getAuthIssuerUrl,
} from "@/api/lib/auth/auth-paths";
import { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import { getMcpProtectedResourceMetadata } from "@/api/mcp/metadata";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import {
  readOAuthRedirect,
  readSignedQuery,
  registerOAuthClient,
} from "@/api/tests/helpers/oauth-grant";

const REDIRECT_URI = "https://connector.example.test/oauth/callback";
const metadataSchema = v.looseObject({
  issuer: v.string(),
  scopes_supported: v.array(v.string()),
  authorization_response_iss_parameter_supported: v.boolean(),
});

let browser: Awaited<ReturnType<typeof signInHuman>>;
let issuer: string;
let requestsIssued = 0;

const requestHeaders = () => {
  requestsIssued += 1;
  const address = `198.51.100.${String(requestsIssued)}`;
  return {
    accept: "application/json",
    "x-forwarded-for": address,
    [AUTH_CLIENT_ADDRESS_HEADER]: address,
  };
};

beforeAll(async () => {
  await initAgentAuthTestDb();
  const discoveredAt = performance.now();
  const metadataResponse = await getAuth().handler(
    new Request(getAuthEndpointUrl(".well-known/oauth-authorization-server")),
  );
  expect(performance.now() - discoveredAt).toBeLessThan(10_000);
  expect(metadataResponse.status).toBe(200);
  const metadata = v.parse(metadataSchema, await metadataResponse.json());
  issuer = metadata.issuer;
  expect(issuer).toBe(getAuthIssuerUrl());
  expect(metadata.scopes_supported).toContain("offline_access");
  expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
  browser = await signInHuman("issuer-responses@example.test");
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

// Each row reaches a distinct authorization rejection boundary; clients are
// isolated so disabled/grant-policy cases cannot affect subsequent requests.
const ERROR_CASES = [
  {
    name: "conflicting request parameters",
    error: "invalid_request",
    changes: {
      request: "opaque",
      request_uri: "https://request.example/object",
    },
  },
  {
    name: "request object",
    error: "request_not_supported",
    changes: { request: "opaque" },
  },
  {
    name: "request URI",
    error: "request_uri_not_supported",
    changes: { request_uri: "https://request.example/object" },
  },
  {
    name: "request URI without client",
    error: "invalid_request",
    changes: { request_uri: "https://request.example/object", client_id: null },
    destination: "server",
  },
  {
    name: "missing client",
    error: "invalid_request",
    changes: { client_id: null },
    destination: "server",
  },
  {
    name: "missing response type",
    error: "invalid_request",
    changes: { response_type: null },
  },
  {
    name: "unsupported response type",
    error: "unsupported_response_type",
    changes: { response_type: "token" },
  },
  {
    name: "invalid prompt combination",
    error: "invalid_request",
    changes: { prompt: "none consent" },
  },
  {
    name: "unconfigured account selection",
    error: "unsupported_prompt_select_account",
    changes: { prompt: "select_account" },
    destination: "server",
  },
  {
    name: "unknown client",
    error: "invalid_client",
    changes: { client_id: "unknown-client" },
    destination: "server",
  },
  {
    name: "disabled client",
    error: "client_disabled",
    clientUpdate: { disabled: true },
    destination: "server",
  },
  {
    name: "disallowed authorization grant",
    error: "unauthorized_client",
    clientUpdate: { grantTypes: ["refresh_token"] },
    destination: "server",
  },
  {
    name: "unregistered redirect",
    error: "invalid_redirect",
    changes: { redirect_uri: "https://untrusted.example/callback" },
    destination: "server",
  },
  {
    name: "missing redirect",
    error: "invalid_redirect",
    changes: { redirect_uri: null },
    destination: "server",
  },
  {
    name: "invalid scope",
    error: "invalid_scope",
    changes: { scope: "unknown:scope" },
  },
  {
    name: "claims without identity scope",
    error: "invalid_request",
    changes: {
      scope: "offline_access",
      claims: JSON.stringify({ id_token: { sub: null } }),
    },
  },
  {
    name: "invalid claims object",
    error: "invalid_request",
    changes: { claims: JSON.stringify({ id_token: "invalid" }) },
  },
  {
    name: "unavailable essential authentication context",
    error: "access_denied",
    changes: {
      claims: JSON.stringify({
        id_token: { acr: { essential: true, value: "unavailable" } },
      }),
    },
  },
  {
    name: "unknown resource",
    error: "invalid_target",
    changes: { resource: "https://resource.example/mcp" },
  },
  {
    name: "malformed resource",
    error: "invalid_request",
    changes: { resource: "not-a-url" },
  },
  {
    name: "missing proof key",
    error: "invalid_request",
    changes: { code_challenge: null, code_challenge_method: null },
  },
  {
    name: "incomplete proof key",
    error: "invalid_request",
    changes: { code_challenge_method: null },
  },
  {
    name: "unsupported proof key method",
    error: "invalid_request",
    changes: { code_challenge_method: "plain" },
  },
  {
    name: "absent noninteractive session",
    error: "login_required",
    changes: { prompt: "none" },
    session: "absent",
  },
  {
    name: "absent noninteractive consent",
    error: "consent_required",
    changes: { prompt: "none" },
  },
  {
    name: "noninteractive organization selection",
    error: "interaction_required",
    changes: {
      prompt: "none",
      scope: "stella:read",
      resource: getMcpResourceUrl(),
    },
  },
] as const satisfies readonly AuthorizationErrorCase[];

const authorizationQuery = (clientId: string) =>
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    state: "issuer-response-state",
  });

const authorize = async (
  query: URLSearchParams,
  session: "present" | "absent" = "present",
) =>
  await getAuth().handler(
    new Request(
      `${getAuthEndpointUrl("oauth2/authorize")}?${query.toString()}`,
      {
        headers: {
          ...requestHeaders(),
          ...(session === "present" ? { cookie: browser.cookieHeader() } : {}),
        },
      },
    ),
  );

type AuthorizationErrorCase = {
  name: string;
  error: string;
  changes?: Record<string, string | null>;
  clientUpdate?: Record<string, unknown>;
  session?: "absent";
  destination?: "server";
};

const assertAuthorizationError = async (scenario: AuthorizationErrorCase) => {
  const client = await registerOAuthClient(undefined, "none");
  if (scenario.clientUpdate) {
    const context = await getAuth().$context;
    await context.adapter.update({
      model: "oauthClient",
      where: [{ field: "clientId", value: client.clientId }],
      update: scenario.clientUpdate,
    });
  }
  const query = authorizationQuery(client.clientId);
  for (const [key, value] of Object.entries(scenario.changes ?? {})) {
    if (value === null) {
      query.delete(key);
    } else {
      query.set(key, value);
    }
  }
  const redirect = await readOAuthRedirect(
    await authorize(query, scenario.session),
  );
  const parameters = redirect.hash
    ? new URLSearchParams(redirect.hash.slice(1))
    : redirect.searchParams;
  expect(parameters.get("error")).toBe(scenario.error);
  expect(parameters.get("iss")).toBe(issuer);
  if (scenario.destination === "server") {
    expect(redirect.origin).toBe(new URL(getAuthEndpointUrl("error")).origin);
    expect(redirect.pathname).toBe(
      new URL(getAuthEndpointUrl("error")).pathname,
    );
    expect(redirect.origin).not.toBe("https://untrusted.example");
  } else {
    expect(redirect.origin).toBe(new URL(REDIRECT_URI).origin);
    expect(parameters.get("state")).toBe("issuer-response-state");
  }
};

describe("OAuth authorization response issuer", () => {
  test("authorization error table covers the installed provider error census", () => {
    const providerEntry = fileURLToPath(
      import.meta.resolve("@better-auth/oauth-provider"),
    );
    const index = readFileSync(providerEntry, "utf-8");
    const authorizationModule = v.parse(
      v.string(),
      index.match(/from "\.\/(authorize-[^"\n]+\.mjs)"/u)?.at(1),
    );
    const source = readFileSync(
      path.join(path.dirname(providerEntry), authorizationModule),
      "utf-8",
    );
    const serverErrorCalls = [
      ...source.matchAll(/getErrorURL\(ctx, [^)\n]+\)/gu),
    ]
      .map(([call]) => call)
      .filter(
        (call) => !call.startsWith("getErrorURL(ctx, error, description"),
      );
    expect(serverErrorCalls.length).toBeGreaterThan(0);
    for (const call of serverErrorCalls) {
      expect(call.endsWith(", opts)")).toBe(true);
    }
    const authorizationStart = source.indexOf(
      "function authorizeRedirectOnError(",
    );
    const authorizationEnd = source.indexOf(
      "function serializeAuthorizationQuery(",
      authorizationStart,
    );
    expect(authorizationStart).toBeGreaterThan(0);
    expect(authorizationEnd).toBeGreaterThan(authorizationStart);
    const authorization = source.slice(authorizationStart, authorizationEnd);
    const errorCodes = new Set<string>();
    for (const pattern of [
      /error: "([a-z_]+)"/gu,
      /getErrorURL\(ctx, ["`]([a-z_]+)["`]/gu,
      /formatErrorURL\(query\.redirect_uri, "([a-z_]+)"/gu,
      /redirectWithPromptNoneError\(ctx, opts, query, "([a-z_]+)"/gu,
      /err\.body\?\.error \?\? "([a-z_]+)"/gu,
    ]) {
      for (const match of authorization.matchAll(pattern)) {
        errorCodes.add(v.parse(v.string(), match.at(1)));
      }
    }
    const plugin = getAuth().options.plugins?.find(
      ({ id }) => id === "oauth-provider",
    );
    const providerOptions = v.parse(
      v.looseObject({
        options: v.looseObject({
          selectAccount: v.optional(v.unknown()),
          requestUriResolver: v.optional(v.unknown()),
        }),
      }),
      plugin,
    ).options;
    // These branches require features this server does not configure. Turning
    // either feature on requires an integration case before this census passes.
    expect(providerOptions.selectAccount).toBeUndefined();
    expect(providerOptions.requestUriResolver).toBeUndefined();
    const exercised = new Set(ERROR_CASES.map(({ error }) => error));
    expect([...errorCodes].toSorted()).toEqual(
      [
        ...exercised,
        "account_selection_required",
        "invalid_request_uri",
      ].toSorted(),
    );
  });
  test("protected resources advertise the exact authorization metadata issuer", () => {
    for (const mode of ["default", "documents", "anonymized", "law"] as const) {
      expect(
        getMcpProtectedResourceMetadata(mode).authorization_servers,
      ).toEqual([issuer]);
    }
  });

  test.each(ERROR_CASES)(
    "includes the metadata issuer for $name",
    assertAuthorizationError,
  );

  test.each([true, false])(
    "includes the exact issuer after consent accept=%s",
    async (accept) => {
      const client = await registerOAuthClient(undefined, "none");
      const consentPage = await readOAuthRedirect(
        await authorize(authorizationQuery(client.clientId)),
      );
      const response = await getAuth().handler(
        new Request(getAuthEndpointUrl("oauth2/consent"), {
          method: "POST",
          headers: {
            ...requestHeaders(),
            "content-type": "application/json",
            cookie: browser.cookieHeader(),
          },
          body: JSON.stringify({
            accept,
            oauth_query: readSignedQuery(consentPage),
          }),
        }),
      );
      const redirect = await readOAuthRedirect(response);
      expect(redirect.origin).toBe(new URL(REDIRECT_URI).origin);
      expect(redirect.searchParams.get("iss")).toBe(issuer);
      expect(redirect.searchParams.get("state")).toBe("issuer-response-state");
      if (accept) {
        expect(redirect.searchParams.get("code")).toBeString();
        expect(redirect.searchParams.has("error")).toBe(false);
      } else {
        expect(redirect.searchParams.get("error")).toBe("access_denied");
        expect(redirect.searchParams.has("code")).toBe(false);
      }
    },
  );
});

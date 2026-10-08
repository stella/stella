import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import * as v from "valibot";

// Mirrors https://chatgpt.com/oauth/client.json, fetched 2026-10-05. The
// documents and signing keys are test-owned; no request reaches ChatGPT.
const CLIENT_ID = "https://chatgpt.com/oauth/client.json";
const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
const JWKS_URI = "https://chatgpt.com/oauth/jwks.json";
const KEY_ID = "confidential-cimd-test";
const PROTOCOL_VERSION = "2026-07-28";
const requestedUrls: string[] = [];
const documents = new Map<string, unknown>();

await mock.module("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requestedUrls.push(url);
    const document = documents.get(url);
    return document === undefined
      ? new Response("not found", { status: 404 })
      : Response.json(document);
  },
}));

const { getAuth } = await import("@/api/lib/auth");
const { getAuthEndpointUrl, getAuthIssuerUrl } =
  await import("@/api/lib/auth/auth-paths");
const { getMcpResourceUrl } = await import("@/api/mcp/constants");
const { handleMcpHttpRequest } = await import("@/api/mcp/server");
const { createHumanSession } =
  await import("@/api/tests/helpers/human-session");
const { initAgentAuthTestDb, releaseAgentAuthTestDb } =
  await import("@/api/tests/helpers/mock-agent-auth-db");
const { readOAuthRedirect, readSignedQuery } =
  await import("@/api/tests/helpers/oauth-grant");

const clientKeys = await generateKeyPair("RS256");
const wrongKeys = await generateKeyPair("RS256");
const fetchSpy = spyOn(globalThis, "fetch");

beforeAll(async () => {
  await initAgentAuthTestDb();
  documents.set(CLIENT_ID, {
    client_id: CLIENT_ID,
    client_uri: "https://chatgpt.com/",
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "ChatGPT",
    logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
    token_endpoint_auth_signing_alg: "RS256",
    jwks_uri: JWKS_URI,
  });
  documents.set(JWKS_URI, {
    keys: [
      {
        ...(await exportJWK(clientKeys.publicKey)),
        kid: KEY_ID,
        alg: "RS256",
        use: "sig",
      },
    ],
  });
  // Only the AS's public keys are served through global fetch. Client JWKS
  // must use the CIMD discovery transport above; bypassing it fails closed.
  fetchSpy.mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(String(input), init);
        expect(request.url).toBe(getAuthEndpointUrl("jwks"));
        return await getAuth().handler(request);
      },
      { preconnect: fetch.preconnect },
    ),
  );
});

afterAll(async () => {
  fetchSpy.mockRestore();
  await releaseAgentAuthTestDb();
});

let requests = 0;
const nextAddress = () => `198.51.100.${String(++requests)}`;

// Every grant uses a fresh human and organization, so an earlier consent
// cannot mask the confidential hosted client's consent requirement.
const authorizeAndConsent = async () => {
  const { browser } = await createHumanSession({
    email: `confidential-cimd-${Bun.randomUUIDv7()}@example.test`,
    orgName: "Confidential CIMD test",
    orgSlugPrefix: "confidential-cimd",
  });
  const verifier = `${Bun.randomUUIDv7()}${Bun.randomUUIDv7()}`;
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  const state = Bun.randomUUIDv7();
  const url = new URL(getAuthEndpointUrl("oauth2/authorize"));
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    resource: getMcpResourceUrl(),
    scope: "stella:read offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();
  const consentPage = await readOAuthRedirect(
    await getAuth().handler(
      new Request(url.href, {
        headers: {
          accept: "application/json",
          cookie: browser.cookieHeader(),
          "x-forwarded-for": nextAddress(),
        },
      }),
    ),
  );
  expect(consentPage.pathname).toBe("/consent");
  const redirect = await readOAuthRedirect(
    await getAuth().handler(
      new Request(getAuthEndpointUrl("oauth2/consent"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: browser.cookieHeader(),
          "x-forwarded-for": nextAddress(),
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: readSignedQuery(consentPage),
        }),
      }),
    ),
  );
  expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
  expect(redirect.searchParams.get("state")).toBe(state);
  expect(redirect.searchParams.get("iss")).toBe(getAuthIssuerUrl());
  const code = v.parse(
    v.pipe(v.string(), v.minLength(1)),
    redirect.searchParams.get("code"),
  );
  return { code, verifier };
};

type AssertionOptions = {
  audience?: string;
  expired?: boolean;
  wrongKey?: boolean;
  jti?: string;
};

const signAssertion = async ({
  audience = getAuthEndpointUrl("oauth2/token"),
  expired = false,
  wrongKey = false,
  jti = Bun.randomUUIDv7(),
}: AssertionOptions = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .setIssuer(CLIENT_ID)
    .setSubject(CLIENT_ID)
    .setAudience(audience)
    .setIssuedAt(now - (expired ? 120 : 0))
    .setExpirationTime(now + (expired ? -60 : 120))
    .setJti(jti)
    .sign(wrongKey ? wrongKeys.privateKey : clientKeys.privateKey);
};

const exchange = async (
  grant: Awaited<ReturnType<typeof authorizeAndConsent>>,
  assertion: string,
) =>
  await getAuth().handler(
    new Request(getAuthEndpointUrl("oauth2/token"), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": nextAddress(),
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_assertion_type:
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
        grant_type: "authorization_code",
        code: grant.code,
        code_verifier: grant.verifier,
        redirect_uri: REDIRECT_URI,
        resource: getMcpResourceUrl(),
      }),
    }),
  );

const readTokens = async (response: Response) => {
  expect(response.status, await response.clone().text()).toBe(200);
  return v.parse(
    v.looseObject({
      access_token: v.pipe(v.string(), v.minLength(1)),
      token_type: v.string(),
    }),
    await response.json(),
  );
};

const expectRefused = async (response: Response) => {
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(await response.json()).toMatchObject({ error: "invalid_client" });
};

const mcpRequest = (token: string, method: "tools/list" | "tools/call") =>
  new Request(getMcpResourceUrl(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method,
      ...(method === "tools/call" ? { "mcp-name": "list_matters" } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requests++,
      method,
      params: {
        ...(method === "tools/call"
          ? { name: "list_matters", arguments: {} }
          : {}),
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: {
            name: "confidential-cimd-test",
            version: "1.0.0",
          },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  });

describe("confidential CIMD private_key_jwt OAuth", () => {
  test.each(["endpoint", "issuer"] as const)(
    "grants an RS256 client assertion with %s audience and admits read-only MCP",
    async (audience) => {
      const grant = await authorizeAndConsent();
      const assertion = await signAssertion({
        audience:
          audience === "endpoint"
            ? getAuthEndpointUrl("oauth2/token")
            : getAuthIssuerUrl(),
      });
      const tokens = await readTokens(await exchange(grant, assertion));
      expect(tokens.token_type.toLowerCase()).toBe("bearer");
      expect(requestedUrls).toContain(CLIENT_ID);
      expect(requestedUrls).toContain(JWKS_URI);
      const listed = await handleMcpHttpRequest(
        mcpRequest(tokens.access_token, "tools/list"),
      );
      expect(listed.status, await listed.clone().text()).toBe(200);
      expect(await listed.json()).toMatchObject({
        result: {
          tools: expect.arrayContaining([
            expect.objectContaining({ name: "list_matters" }),
          ]),
        },
      });
      const called = await handleMcpHttpRequest(
        mcpRequest(tokens.access_token, "tools/call"),
      );
      expect(called.status, await called.clone().text()).toBe(200);
      const result = await called.json();
      expect(result).toMatchObject({
        result: {
          content: expect.arrayContaining([
            expect.objectContaining({ type: "text", text: expect.any(String) }),
          ]),
          structuredContent: { matters: [] },
        },
      });
      expect(result).not.toMatchObject({ result: { isError: true } });
    },
  );

  test.each([
    { name: "wrong signing key", options: { wrongKey: true } },
    {
      name: "wrong audience",
      options: { audience: "https://attacker.example/token" },
    },
    { name: "expired assertion", options: { expired: true } },
  ])(
    "refuses $name before consuming an authorization code",
    async ({ options }) => {
      const grant = await authorizeAndConsent();
      await expectRefused(await exchange(grant, await signAssertion(options)));
      // The same code succeeds with a fresh valid assertion: refusal happened
      // at client authentication, rather than an unrelated invalid-code error.
      await readTokens(await exchange(grant, await signAssertion()));
    },
  );

  test("refuses a replayed assertion jti even with a fresh code", async () => {
    const assertion = await signAssertion();
    await readTokens(await exchange(await authorizeAndConsent(), assertion));
    const grant = await authorizeAndConsent();
    const replayed = await exchange(grant, assertion);
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toMatchObject({
      error: "invalid_client",
      error_description: "client assertion jti has already been used",
    });
    await readTokens(await exchange(grant, await signAssertion()));
  });
});

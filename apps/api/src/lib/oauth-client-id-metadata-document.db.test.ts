import type { SchemaClient } from "@better-auth/oauth-provider";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as v from "valibot";

/**
 * Client ID Metadata Document discovery, driven through the real authorization
 * endpoint.
 *
 * The transport is substituted at the discovery's own seam: `auth.ts` passes
 * `fetchClientMetadataResource` from `@better-auth/cimd/node` into
 * `createCimdClientDiscovery`, and this replaces that module. Nothing here
 * mocks global fetch, so the plugin's own URL policy still decides whether a
 * request is attempted at all, which is what the refusal cases assert.
 */

const DOCUMENT_URL = "https://client.example.com/oauth/client-metadata.json";
const REDIRECT_URI = "https://client.example.com/oauth/callback";
const FOREIGN_REDIRECT_URI = "https://attacker.example.net/oauth/callback";

const documentsByUrl = new Map<string, unknown>();
const requestedUrls: string[] = [];

const metadataDocument = (overrides: Record<string, unknown> = {}) => ({
  client_id: DOCUMENT_URL,
  client_name: "Metadata Document Client",
  grant_types: ["authorization_code", "refresh_token"],
  redirect_uris: [REDIRECT_URI],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  ...overrides,
});

await mock.module("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requestedUrls.push(url);
    const document = documentsByUrl.get(url);
    if (document === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(document), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  },
}));

const { getAuth } = await import("@/api/lib/auth");
const { getAuthEndpointUrl, getAuthIssuerUrl } =
  await import("@/api/lib/auth/auth-paths");
const { initAgentAuthTestDb, releaseAgentAuthTestDb } =
  await import("@/api/tests/helpers/mock-agent-auth-db");

beforeAll(async () => {
  await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

// Better Auth buckets rate limits per client address, so every request here
// comes from its own RFC 5737 documentation address.
let requestsIssued = 0;

const authorize = async (
  clientId: string,
  redirectUri: string,
): Promise<Response> => {
  requestsIssued += 1;
  const query = new URLSearchParams({
    client_id: clientId,
    // A fixed verifier's S256 challenge; PKCE is mandatory for these clients.
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid",
  });
  return await getAuth().handler(
    new Request(
      `${getAuthEndpointUrl("oauth2/authorize")}?${query.toString()}`,
      {
        headers: { "x-forwarded-for": `198.51.100.${String(requestsIssued)}` },
      },
    ),
  );
};

/**
 * A refusal arrives either as a JSON `invalid_client` body, when the discovery
 * rejects the `client_id` itself, or as a redirect to this server's own error
 * page. It must never be a redirect to the client's URI: the authorization
 * server cannot bounce a user agent to a target it has not accepted. Returns
 * the error text either shape carries.
 */
const refusalFrom = async (response: Response): Promise<string> => {
  const location = response.headers.get("location");
  if (location === null) {
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ error: expect.any(String) });
    return JSON.stringify(body);
  }

  expect(location.startsWith(getAuthIssuerUrl())).toBe(true);
  expect(location).not.toContain("attacker.example.net");
  const { searchParams } = new URL(location);
  const error = searchParams.get("error");
  expect(error).toEqual(expect.any(String));
  return `${error ?? ""} ${searchParams.get("error_description") ?? ""}`;
};

describe("OAuth client ID metadata documents", () => {
  const ELEVATED_SCOPES = [
    "stella:admin_read",
    "stella:admin_write",
    "stella:external_mcps",
  ];
  const ELEVATED_SCOPE = ELEVATED_SCOPES.join(" ");

  const elevatedIn = (scope: string | null) =>
    (scope ?? "").split(" ").filter((value) => ELEVATED_SCOPES.includes(value));

  /** The scope the provider signs into the authorization request it continues. */
  const signedScope = async (clientId: string, scope: string | null) => {
    requestsIssued += 1;
    const parameters = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      ...(scope === null ? {} : { scope }),
    });
    const authorized = await getAuth().handler(
      new Request(
        `${getAuthEndpointUrl("oauth2/authorize")}?${parameters.toString()}`,
        {
          headers: {
            "x-forwarded-for": `198.51.100.${String(requestsIssued)}`,
          },
        },
      ),
    );
    expect(authorized.status).toBe(302);
    const location = v.parse(v.string(), authorized.headers.get("location"));
    const signed = v.parse(
      v.string(),
      new URLSearchParams(new URL(location).hash.slice(1)).get("oauth_query"),
    );
    return new URLSearchParams(signed).get("scope");
  };

  test("grants other discovered apps the open capability subset", async () => {
    const clientId = "https://capabilities.example.com/oauth/client.json";
    documentsByUrl.set(
      clientId,
      metadataDocument({
        client_id: clientId,
        scope: `openid ${ELEVATED_SCOPE}`,
      }),
    );
    // The first request discovers the app and names no scope.
    const discovered = await signedScope(clientId, null);
    expect(discovered?.split(" ")).toContain("stella:read");
    expect(elevatedIn(discovered)).toEqual([]);
    const context = await getAuth().$context;
    const client = await context.adapter.findOne<
      SchemaClient<readonly string[]>
    >({
      model: "oauthClient",
      where: [{ field: "clientId", value: clientId }],
    });
    expect(client?.clientDiscoveryId).toBe("cimd");
    expect(await signedScope(clientId, null)).toBe(discovered);
    expect(await signedScope(clientId, `openid ${ELEVATED_SCOPE}`)).toBe(
      "openid",
    );
  });

  test("retains configured capabilities for documented apps", async () => {
    const clientId = "https://claude.ai/oauth/claude-code-client-metadata";
    documentsByUrl.set(
      clientId,
      metadataDocument({
        client_id: clientId,
        scope: `openid ${ELEVATED_SCOPE}`,
      }),
    );
    expect(elevatedIn(await signedScope(clientId, null))).toEqual(
      ELEVATED_SCOPES,
    );
    expect(await signedScope(clientId, ELEVATED_SCOPE)).toBe(ELEVATED_SCOPE);
  });

  test("accepts a document whose redirect_uris cover the request", async () => {
    documentsByUrl.set(DOCUMENT_URL, metadataDocument());
    requestedUrls.length = 0;

    const response = await authorize(DOCUMENT_URL, REDIRECT_URI);

    // No session, so the user agent is sent to sign in. Reaching the login
    // page means the client resolved from its document and was accepted.
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("oauth_query=");
    expect(requestedUrls).toEqual([DOCUMENT_URL]);
  });

  // Native clients list a portless loopback callback on one or two loopback
  // hosts, then bind whichever host and port is free (RFC 8252 7.3, 8.3).
  const nativeDocument = (
    documentUrl: string,
    overrides: Record<string, unknown> = {},
  ) => {
    documentsByUrl.set(
      documentUrl,
      metadataDocument({
        client_id: documentUrl,
        redirect_uris: [
          "http://localhost/callback",
          "http://127.0.0.1/callback",
        ],
        ...overrides,
      }),
    );
  };
  const NATIVE_DOCUMENT_URL =
    "https://native.example.com/oauth/client-metadata.json";

  /** The redirect the sign-in hand-off will complete to, exactly as sent. */
  const handedOffRedirect = (response: Response): string | null => {
    expect(response.status).toBe(302);
    const location = new URL(
      v.parse(v.string(), response.headers.get("location")),
      getAuthIssuerUrl(),
    );
    const oauthQuery =
      location.searchParams.get("oauth_query") ??
      new URLSearchParams(location.hash.slice(1)).get("oauth_query");
    return new URLSearchParams(oauthQuery ?? "").get("redirect_uri");
  };

  test.each([
    "http://localhost:49152/callback",
    "http://127.0.0.1:49152/callback",
    "http://[::1]:49152/callback",
    "http://[::1]/callback",
  ])(
    "accepts a listed loopback host, or the other IP literal, on any port: %s",
    async (redirectUri) => {
      nativeDocument(NATIVE_DOCUMENT_URL);

      const response = await authorize(NATIVE_DOCUMENT_URL, redirectUri);

      expect(handedOffRedirect(response)).toBe(redirectUri);
    },
  );

  test("an IPv4 literal listing admits IPv6 loopback but not localhost", async () => {
    const documentUrl = "https://native-app.example.com/oauth/client.json";
    nativeDocument(documentUrl, {
      application_type: "native",
      redirect_uris: ["http://127.0.0.1/callback"],
    });

    expect(
      handedOffRedirect(
        await authorize(documentUrl, "http://[::1]:49152/callback"),
      ),
    ).toBe("http://[::1]:49152/callback");
    expect(
      await refusalFrom(
        await authorize(documentUrl, "http://localhost:49152/callback"),
      ),
    ).toMatch(/invalid_re/u);
  });

  test("a localhost-only listing keeps port-only matching", async () => {
    const documentUrl =
      "https://native-localhost.example.com/oauth/client.json";
    nativeDocument(documentUrl, {
      redirect_uris: ["http://localhost/callback"],
    });

    expect(
      await refusalFrom(
        await authorize(documentUrl, "http://[::1]:49152/callback"),
      ),
    ).toMatch(/invalid_re/u);
  });

  test.each([
    "http://[::1]:49152/other",
    "http://127.0.0.2:49152/callback",
    "https://[::1]:49152/callback",
    "http://[::1]:49152/callback?extra=1",
  ])(
    "refuses a loopback callback that differs beyond host and port: %s",
    async (redirectUri) => {
      nativeDocument(NATIVE_DOCUMENT_URL);

      const response = await authorize(NATIVE_DOCUMENT_URL, redirectUri);

      expect(await refusalFrom(response)).toMatch(/invalid_re/u);
    },
  );

  test("refuses a request whose redirect_uri the document does not list", async () => {
    documentsByUrl.set(DOCUMENT_URL, metadataDocument());

    const response = await authorize(DOCUMENT_URL, FOREIGN_REDIRECT_URI);

    expect(await refusalFrom(response)).toContain("invalid_redirect");
  });

  test("refuses a document whose client_id is not its own URL", async () => {
    const impersonatingUrl =
      "https://other.example.com/oauth/client-metadata.json";
    // Claims the first client's identity while served from another origin.
    documentsByUrl.set(impersonatingUrl, metadataDocument());
    requestedUrls.length = 0;

    const response = await authorize(impersonatingUrl, REDIRECT_URI);

    expect(await refusalFrom(response)).toContain(
      "does not match the metadata document URL",
    );
    // It was fetched, then rejected on content: the mismatch is the reason.
    expect(requestedUrls).toEqual([impersonatingUrl]);
  });

  test("refuses a private-address client_id before fetching anything", async () => {
    for (const clientId of [
      "https://169.254.169.254/oauth/client-metadata.json",
      "https://127.0.0.1/oauth/client-metadata.json",
      "https://10.0.0.1/oauth/client-metadata.json",
    ]) {
      requestedUrls.length = 0;

      const response = await authorize(clientId, REDIRECT_URI);

      expect(await refusalFrom(response)).toContain(
        "must not target a private or reserved address",
      );
      // The URL policy runs before the transport, so nothing is requested:
      // this is the SSRF gate, not a failed connection.
      expect(requestedUrls).toEqual([]);
    }
  });

  test("refuses a plain-http client_id before fetching anything", async () => {
    requestedUrls.length = 0;

    const response = await authorize(
      "http://client.example.com/oauth/client-metadata.json",
      REDIRECT_URI,
    );

    // Discovery only claims https URLs, so this is never a metadata-document
    // client; it resolves to no client at all.
    expect(await refusalFrom(response)).toContain("invalid_client");
    expect(requestedUrls).toEqual([]);
  });

  test("leaves a conventionally registered client unaffected", async () => {
    requestsIssued += 1;
    const registration = await getAuth().handler(
      new Request(getAuthEndpointUrl("oauth2/register"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `198.51.100.${String(requestsIssued)}`,
        },
        body: JSON.stringify({
          client_name: "Registered Client",
          grant_types: ["authorization_code"],
          redirect_uris: ["https://registered.example.com/callback"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(registration.status).toBe(201);
    const registered = v.parse(
      v.looseObject({ client_id: v.pipe(v.string(), v.minLength(1)) }),
      await registration.json(),
    );

    requestedUrls.length = 0;
    const response = await authorize(
      registered.client_id,
      "https://registered.example.com/callback",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("oauth_query=");
    // An opaque client_id is not a URL, so no discovery runs for it.
    expect(requestedUrls).toEqual([]);
  });
});

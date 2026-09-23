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
  await import("@/api/lib/auth-paths");
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

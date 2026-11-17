import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { OUTLOOK_SCOPES } from "@stll/api-contract/outlook-client";

import {
  type AuthorizationServerMetadata,
  discoverAuthorizationServer,
  resolveClientId,
} from "@/lib/oauth/discovery";

type Recorded = { body: string; credentials: string | undefined; url: string };

const recordingFetch = (answer: (url: string) => Response) => {
  const requests: Recorded[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    requests.push({
      body: typeof init?.body === "string" ? init.body : "",
      credentials: init?.credentials,
      url: input,
    });
    return await Promise.resolve(answer(input));
  };
  return { fetch, requests };
};

const metadataFor = (issuer: string): AuthorizationServerMetadata => ({
  authorization_endpoint: `${issuer}/oauth2/authorize`,
  client_id_metadata_document_supported: true,
  code_challenge_methods_supported: ["S256"],
  issuer,
  registration_endpoint: `${issuer}/oauth2/register`,
  token_endpoint: `${issuer}/oauth2/token`,
});

describe("authorization server discovery", () => {
  test("falls back to better-auth's mount and sends no cookies", async () => {
    const network = recordingFetch((url) =>
      url.endsWith("/api/auth/.well-known/oauth-authorization-server")
        ? Response.json(metadataFor("https://api.example.test/api/auth"))
        : new Response(null, { status: 404 }),
    );

    const metadata = await discoverAuthorizationServer({
      apiOrigin: "https://api.example.test",
      fetch: network.fetch,
      policy: { allowLoopbackHttp: false },
    });

    expect(Result.isOk(metadata)).toBe(true);
    expect(network.requests.map((request) => request.credentials)).toEqual([
      "omit",
      "omit",
    ]);
  });

  test("refuses a plain-http server outside development", async () => {
    const network = recordingFetch(() =>
      Response.json(metadataFor("http://localhost:3001/api/auth")),
    );

    const metadata = await discoverAuthorizationServer({
      apiOrigin: "http://localhost:3001",
      fetch: network.fetch,
      policy: { allowLoopbackHttp: false },
    });

    expect(Result.isError(metadata) ? metadata.error.failure : null).toBe(
      "unavailable",
    );
  });
});

describe("client id", () => {
  test("uses the published metadata document on an https issuer", async () => {
    const network = recordingFetch(() => new Response(null, { status: 500 }));

    const clientId = await resolveClientId({
      fetch: network.fetch,
      metadata: metadataFor("https://api.example.test/api/auth"),
      redirectUri: "https://outlook.example.test/auth/callback.html",
      resource: "https://api.example.test/v1",
    });

    expect(Result.isOk(clientId) ? clientId.value : null).toBe(
      "https://api.example.test/v1/mcp/oauth/outlook-client-metadata.json",
    );
    expect(network.requests).toEqual([]);
  });

  test("registers a public client on a local http issuer", async () => {
    const network = recordingFetch(() =>
      Response.json({ client_id: "registered-client" }),
    );

    const clientId = await resolveClientId({
      fetch: network.fetch,
      metadata: metadataFor("http://localhost:3001/api/auth"),
      redirectUri: "https://localhost:3002/auth/callback.html",
      resource: "http://localhost:3001/v1",
    });

    expect(Result.isOk(clientId) ? clientId.value : null).toBe(
      "registered-client",
    );
    expect(network.requests.at(0)?.url).toBe(
      "http://localhost:3001/api/auth/oauth2/register",
    );
    expect(network.requests.at(0)?.credentials).toBe("omit");
    expect(JSON.parse(network.requests.at(0)?.body ?? "")).toEqual({
      application_type: "native",
      client_name: "stella for Outlook",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["https://localhost:3002/auth/callback.html"],
      resources: ["http://localhost:3001/v1"],
      response_types: ["code"],
      scope: OUTLOOK_SCOPES.join(" "),
      token_endpoint_auth_method: "none",
    });
  });
});

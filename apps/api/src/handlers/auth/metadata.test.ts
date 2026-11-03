import { afterAll, describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  AGENT_AUTH_IDENTITY_PATH,
  AGENT_AUTH_IDENTITY_TYPES,
  getAgentAuthManifestUrl,
  getAgentAuthUrl,
} from "@/api/agent-auth/constants";
import {
  authCapabilitiesRoute,
  authMetadataRoute,
} from "@/api/handlers/auth/routes";
import { PUBLIC_CORS_PREFLIGHT_MAX_AGE_SECONDS } from "@/api/handlers/public-cors";
import { createHttpApp } from "@/api/http/app";
import { responseCachePolicy } from "@/api/http/cache";
import {
  getAuthEndpointUrl,
  getAuthIssuerUrl,
  OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OPENID_CONFIGURATION_DISCOVERY_PATH,
  ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
} from "@/api/lib/auth/auth-paths";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveRoutesForTest } from "@/api/tests/helpers/serve-routes";
import { serveForTest } from "@/api/tests/helpers/test-server";

// The cache stage decides `Cache-Control` from each route's declared policy.
const server = serveForTest(
  createHttpApp({
    routes: [...authMetadataRoute, ...authCapabilitiesRoute],
    middleware: [responseCachePolicy, errorBoundary],
  }),
);
afterAll(async () => {
  await server.stop();
});

describe("OAuth authorization server metadata", () => {
  const assertMetadataResponse = async (path: string) => {
    const response = await server.fetch(new Request(`http://localhost${path}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, OPTIONS",
    );

    const body = v.parse(
      v.object({
        authorization_endpoint: v.string(),
        issuer: v.string(),
        registration_endpoint: v.string(),
        scopes_supported: v.array(v.string()),
        token_endpoint: v.string(),
        token_endpoint_auth_methods_supported: v.array(v.string()),
        client_id_metadata_document_supported: v.boolean(),
        agent_auth: v.object({
          skill: v.string(),
          identity_endpoint: v.string(),
          claim_endpoint: v.string(),
          events_endpoint: v.string(),
          identity_types_supported: v.array(v.string()),
          identity_assertion: v.object({
            assertion_types_supported: v.array(v.string()),
          }),
          events_supported: v.array(v.string()),
        }),
      }),
      await response.json(),
    );

    expect(body.issuer).toBe(getAuthIssuerUrl());
    expect(body.authorization_endpoint).toBe(
      getAuthEndpointUrl("oauth2/authorize"),
    );
    expect(body.token_endpoint).toBe(getAuthEndpointUrl("oauth2/token"));
    expect(body.registration_endpoint).toBe(
      getAuthEndpointUrl("oauth2/register"),
    );
    expect(body.scopes_supported).toContain("openid");
    expect(body.scopes_supported).toContain("profile");
    expect(body.scopes_supported).toContain("email");
    expect(body.scopes_supported).toContain("stella:read");
    expect(body.scopes_supported).toContain("stella:search");
    expect(body.scopes_supported).toContain("stella:skills");
    expect(body.scopes_supported).toContain("stella:external_mcps");
    expect(body.scopes_supported).toContain("stella:read_anonymized");
    expect(body.scopes_supported).toContain("stella:search_anonymized");
    // Grantable protocol scope: without it in the live oauthProvider config,
    // no client (MCP connectors, the CLI) can ever request a refresh token
    // and access tokens die after ACCESS_TOKEN_EXPIRES_IN with no way to
    // renew short of full re-consent.
    expect(body.scopes_supported).toContain("offline_access");
    // A hosted client that discovers this document must see CIMD advertised;
    // without the flag it falls back to per-user dynamic registration.
    expect(body.client_id_metadata_document_supported).toBe(true);
    expect(body.token_endpoint_auth_methods_supported).toContain("none");
    expect(body.token_endpoint_auth_methods_supported).toContain(
      "client_secret_basic",
    );

    // auth.md agent_auth profile block (merged onto the RFC 8414 doc).
    expect(body.agent_auth.skill).toBe(getAgentAuthManifestUrl());
    expect(body.agent_auth.identity_endpoint).toBe(
      getAgentAuthUrl(AGENT_AUTH_IDENTITY_PATH),
    );
    // Default deployment has FEATURE_AGENT_ID_JAG off, so discovery advertises
    // only the flows the endpoint actually accepts (no identity_assertion).
    expect(body.agent_auth.identity_types_supported).toEqual(
      AGENT_AUTH_IDENTITY_TYPES.filter((type) => type !== "identity_assertion"),
    );
    expect(
      body.agent_auth.identity_assertion.assertion_types_supported,
    ).toEqual([]);
  };

  test("serves RFC 8414 metadata from the canonical issuer-specific path", async () => {
    await assertMetadataResponse(OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH);
  });

  test("serves RFC 8414 metadata from the root compatibility path", async () => {
    await assertMetadataResponse(
      ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
    );
  });

  test("serves OpenID discovery metadata from the root compatibility path", async () => {
    await assertMetadataResponse(OPENID_CONFIGURATION_DISCOVERY_PATH);
  });

  test("answers CORS preflight requests", async () => {
    const response = await server.fetch(
      new Request(
        `http://localhost${ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH}`,
        { method: "OPTIONS" },
      ),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, OPTIONS",
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "MCP-Protocol-Version",
    );
    expect(response.headers.get("Access-Control-Max-Age")).toBe(
      String(PUBLIC_CORS_PREFLIGHT_MAX_AGE_SECONDS),
    );
  });

  test("answers a third-party preflight ahead of the credentialed CORS layer", async () => {
    // Served behind the API's own pipeline: its CORS stage answers preflights
    // for the app's origins with credentials, which a third-party MCP client
    // must never receive for these documents.
    await using piped = serveRoutesForTest(authMetadataRoute);
    for (const path of [
      ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
      OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
      OPENID_CONFIGURATION_DISCOVERY_PATH,
    ]) {
      const response = await piped.fetch(
        new Request(`http://localhost${path}`, {
          method: "OPTIONS",
          headers: {
            origin: "https://client.example.test",
            "access-control-request-method": "GET",
            "access-control-request-headers": "mcp-protocol-version",
          },
        }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
        "MCP-Protocol-Version",
      );
      expect(
        response.headers.get("Access-Control-Allow-Credentials"),
      ).toBeNull();
      expect(response.headers.get("Vary")).toBeNull();
    }
  });
});

describe("auth capabilities", () => {
  test("reports social providers as unavailable when provider credentials are not configured", async () => {
    const response = await server.fetch(
      new Request("http://localhost/auth/capabilities"),
    );

    expect(response.status).toBe(200);

    const body = v.parse(
      v.object({
        social: v.object({
          google: v.literal(false),
          microsoft: v.literal(false),
          apple: v.literal(false),
        }),
      }),
      await response.json(),
    );

    expect(body.social).toEqual({
      google: false,
      microsoft: false,
      apple: false,
    });
  });
});

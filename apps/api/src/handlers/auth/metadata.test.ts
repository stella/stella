import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { authMetadataRoute } from "@/api/handlers/auth/routes";
import {
  getAuthEndpointUrl,
  getAuthIssuerUrl,
  OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
  OPENID_CONFIGURATION_DISCOVERY_PATH,
  ROOT_OAUTH_AUTHORIZATION_SERVER_DISCOVERY_PATH,
} from "@/api/lib/auth-paths";

describe("OAuth authorization server metadata", () => {
  const assertMetadataResponse = async (path: string) => {
    const response = await authMetadataRoute.handle(
      new Request(`http://localhost${path}`),
    );

    expect(response.status).toBe(200);
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
    expect(body.scopes_supported).toContain("stella:read_anonymized");
    expect(body.scopes_supported).toContain("stella:search_anonymized");
    expect(body.token_endpoint_auth_methods_supported).toContain("none");
    expect(body.token_endpoint_auth_methods_supported).toContain(
      "client_secret_basic",
    );
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
    const response = await authMetadataRoute.handle(
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
  });
});

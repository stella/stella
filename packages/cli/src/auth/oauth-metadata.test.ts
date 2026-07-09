import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { discoverAuthorizationServerMetadata } from "./oauth-metadata.js";

describe("discoverAuthorizationServerMetadata", () => {
  test("accepts RFC metadata with server-advertised extension fields", async () => {
    const server = Bun.serve({
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/.well-known/oauth-authorization-server") {
          return new Response("Not found", { status: 404 });
        }

        return Response.json({
          authorization_endpoint: `${url.origin}/api/auth/oauth2/authorize`,
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          issuer: `${url.origin}/api/auth`,
          jwks_uri: `${url.origin}/api/auth/jwks`,
          registration_endpoint: `${url.origin}/api/auth/oauth2/register`,
          scopes_supported: ["openid", "stella:read"],
          token_endpoint: `${url.origin}/api/auth/oauth2/token`,
          token_endpoint_auth_methods_supported: ["none"],
        });
      },
      port: 0,
    });

    try {
      const result = await discoverAuthorizationServerMetadata(
        server.url.origin,
      );

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.authorization_endpoint).toBe(
          `${server.url.origin}/api/auth/oauth2/authorize`,
        );
      }
    } finally {
      await server.stop();
    }
  });
});

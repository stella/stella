import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import type { AuthorizationServerMetadata } from "./oauth-metadata.js";
import { exchangeAuthorizationCode } from "./token-exchange.js";

// `exchangeAuthorizationCode` is the last hop of `stella auth login`: a bad
// response here must surface as a typed `TokenExchangeError`, never a thrown
// exception or a half-parsed token. These pin the error-classification paths
// (`describeTokenEndpointError` + schema parse) that the happy-path type never
// exercises.

const startTokenServer = (respond: (body: URLSearchParams) => Response) => {
  const server = Bun.serve({
    fetch: async (request) =>
      respond(new URLSearchParams(await request.text())),
    hostname: "127.0.0.1",
    port: 0,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const metadata: AuthorizationServerMetadata = {
    authorization_endpoint: `${origin}/authorize`,
    issuer: origin,
    token_endpoint: `${origin}/token`,
  };
  return {
    close: () => {
      void server.stop(true);
    },
    metadata,
  };
};

let active: { close: () => void } | undefined;
afterEach(() => {
  active?.close();
  active = undefined;
});

const exchange = (metadata: AuthorizationServerMetadata) =>
  exchangeAuthorizationCode({
    clientId: "client-1",
    code: "auth-code-1",
    codeVerifier: "verifier-1",
    metadata,
    redirectUri: "http://127.0.0.1/callback",
    resource: "https://stella.example/mcp",
  });

describe("exchangeAuthorizationCode error paths", () => {
  test("maps an RFC 6749 error body to a TokenExchangeError carrying the oauthError", async () => {
    const server = startTokenServer(
      () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "authorization code expired",
          }),
          { headers: { "Content-Type": "application/json" }, status: 400 },
        ),
    );
    active = server;

    const result = await exchange(server.metadata);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("TokenExchangeError");
      expect(result.error.oauthError).toBe("invalid_grant");
      expect(result.error.message).toBe("authorization code expired");
    }
  });

  test("falls back to the error code when no error_description is present", async () => {
    const server = startTokenServer(
      () =>
        new Response(JSON.stringify({ error: "invalid_client" }), {
          headers: { "Content-Type": "application/json" },
          status: 401,
        }),
    );
    active = server;

    const result = await exchange(server.metadata);
    if (Result.isError(result)) {
      expect(result.error.oauthError).toBe("invalid_client");
      expect(result.error.message).toBe("invalid_client");
    } else {
      throw new Error("expected an error");
    }
  });

  test("uses a non-JSON error body verbatim as the message", async () => {
    const server = startTokenServer(
      () => new Response("upstream is down", { status: 502 }),
    );
    active = server;

    const result = await exchange(server.metadata);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("TokenExchangeError");
      expect(result.error.message).toBe("upstream is down");
      expect(result.error.oauthError).toBeUndefined();
    } else {
      throw new Error("expected an error");
    }
  });

  test("synthesizes a status message when the error body is empty", async () => {
    const server = startTokenServer(() => new Response("", { status: 500 }));
    active = server;

    const result = await exchange(server.metadata);
    if (Result.isError(result)) {
      expect(result.error.message).toContain("500");
    } else {
      throw new Error("expected an error");
    }
  });

  test("rejects a 200 response whose token JSON is missing required fields", async () => {
    // Server returns 200 but omits `access_token`: the schema parse must throw
    // and be caught, not produce a credential with an undefined token.
    const server = startTokenServer(
      () =>
        new Response(
          JSON.stringify({ token_type: "Bearer", expires_in: 900 }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
    );
    active = server;

    const result = await exchange(server.metadata);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("TokenExchangeError");
    }
  });

  test("rejects a 200 response whose body is not JSON at all", async () => {
    const server = startTokenServer(
      () =>
        new Response("<html>not json</html>", {
          headers: { "Content-Type": "text/html" },
          status: 200,
        }),
    );
    active = server;

    const result = await exchange(server.metadata);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("TokenExchangeError");
    }
  });

  test("sends the authorization_code grant contract and returns the parsed token on success", async () => {
    let seen: URLSearchParams | undefined;
    const server = startTokenServer((body) => {
      seen = body;
      return new Response(
        JSON.stringify({
          access_token: "at-1",
          expires_in: 900,
          refresh_token: "rt-1",
          scope: "openid stella:read",
          token_type: "Bearer",
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 },
      );
    });
    active = server;

    const result = await exchange(server.metadata);
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.access_token).toBe("at-1");
      expect(result.value.refresh_token).toBe("rt-1");
    }
    // The exact form fields the token endpoint requires (RFC 6749 S4.1.3).
    expect(seen?.get("grant_type")).toBe("authorization_code");
    expect(seen?.get("code")).toBe("auth-code-1");
    expect(seen?.get("code_verifier")).toBe("verifier-1");
    expect(seen?.get("redirect_uri")).toBe("http://127.0.0.1/callback");
    expect(seen?.get("resource")).toBe("https://stella.example/mcp");
  });
});

import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";

import { registerLoopbackClient } from "./oauth-client-registration.js";
import type { AuthorizationServerMetadata } from "./oauth-metadata.js";

const registrationBodySchema = v.record(v.string(), v.unknown());

// Dynamic client registration (RFC 7591). The failure paths are what matter:
// a server that does not advertise a registration endpoint, a rejected
// registration, and a malformed success body must all surface as a typed
// `ClientRegistrationError` so `login.ts` aborts instead of proceeding with an
// undefined client id.

const startRegistrationServer = (
  respond: (body: Record<string, unknown>) => Response,
) => {
  const server = Bun.serve({
    fetch: async (request) => {
      const raw: unknown = await request.json().catch(() => ({}));
      return respond(v.parse(registrationBodySchema, raw));
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const metadata: AuthorizationServerMetadata = {
    authorization_endpoint: `${origin}/authorize`,
    issuer: origin,
    registration_endpoint: `${origin}/register`,
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

describe("registerLoopbackClient", () => {
  test("fails closed when the server advertises no registration_endpoint", async () => {
    const metadata: AuthorizationServerMetadata = {
      authorization_endpoint: "https://stella.example/authorize",
      issuer: "https://stella.example",
      token_endpoint: "https://stella.example/token",
    };

    const result = await registerLoopbackClient(metadata, ["stella:read"]);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("ClientRegistrationError");
      expect(result.error.message).toContain("registration_endpoint");
    }
  });

  test("surfaces a non-2xx registration response with status and body", async () => {
    const server = startRegistrationServer(
      () => new Response("registration disabled", { status: 403 }),
    );
    active = server;

    const result = await registerLoopbackClient(server.metadata, [
      "stella:read",
    ]);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("ClientRegistrationError");
      expect(result.error.message).toContain("403");
      expect(result.error.message).toContain("registration disabled");
    } else {
      throw new TypeError("expected an error");
    }
  });

  test("rejects a 2xx response that omits client_id", async () => {
    const server = startRegistrationServer(
      () =>
        new Response(JSON.stringify({ client_name: "stella-cli" }), {
          headers: { "Content-Type": "application/json" },
          status: 201,
        }),
    );
    active = server;

    const result = await registerLoopbackClient(server.metadata, [
      "stella:read",
    ]);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error._tag).toBe("ClientRegistrationError");
    }
  });

  test("returns the client_id and forwards a public-client body on success", async () => {
    let sent: Record<string, unknown> | undefined;
    const server = startRegistrationServer((body) => {
      sent = body;
      return new Response(JSON.stringify({ client_id: "dyn-client-9" }), {
        headers: { "Content-Type": "application/json" },
        status: 201,
      });
    });
    active = server;

    const result = await registerLoopbackClient(server.metadata, [
      "stella:read",
      "stella:search",
    ]);
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toBe("dyn-client-9");
    }
    // A CLI login is a public native client: no secret, loopback redirect, and
    // the negotiated scopes are documented in the request body.
    expect(sent?.["token_endpoint_auth_method"]).toBe("none");
    expect(sent?.["scope"]).toBe("stella:read stella:search");
    expect(sent?.["redirect_uris"]).toEqual(["http://127.0.0.1/callback"]);
  });
});

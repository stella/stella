import { describe, expect, test } from "bun:test";

import { discoverAuthorizationServer } from "./discovery";
import type { Fetch } from "./http";

const SERVER = "https://stella.example.com";
const ISSUER = `${SERVER}/api/auth`;

const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth2/authorize`,
  token_endpoint: `${ISSUER}/oauth2/token`,
  revocation_endpoint: `${ISSUER}/oauth2/revoke`,
  code_challenge_methods_supported: ["S256"],
};

/** A server publishing `metadata` at better-auth's mount, as stella does. */
const serving =
  (metadata: Record<string, unknown>): Fetch =>
  async (input) =>
    await Promise.resolve(
      input === `${SERVER}/api/auth/.well-known/oauth-authorization-server`
        ? Response.json(metadata)
        : new Response(null, { status: 404 }),
    );

const discover = async (
  metadata: Record<string, unknown>,
  allowPlainHttp = false,
) => {
  const result = await discoverAuthorizationServer(serving(metadata), SERVER, {
    allowPlainHttp,
  });
  return result.isOk() ? result.value.token_endpoint : result.error._tag;
};

describe("authorization server discovery", () => {
  test("finds stella's metadata at better-auth's mount", async () => {
    expect(await discover(METADATA)).toBe(METADATA.token_endpoint);
  });

  test("refuses a server without S256 PKCE", async () => {
    expect(
      await discover({
        ...METADATA,
        code_challenge_methods_supported: ["plain"],
      }),
    ).toBe("DiscoveryError");
    const { code_challenge_methods_supported: _omitted, ...withoutPkce } =
      METADATA;
    expect(await discover(withoutPkce)).toBe("DiscoveryError");
  });

  test("refuses metadata that would send a credential over plain http", async () => {
    for (const field of [
      "issuer",
      "authorization_endpoint",
      "token_endpoint",
      "revocation_endpoint",
    ] as const) {
      const insecure = {
        ...METADATA,
        [field]: METADATA[field].replace("https://", "http://"),
      };
      expect(await discover(insecure)).toBe("DiscoveryError");
    }
  });

  test("a development build reaches a simulator host's local server", async () => {
    const local = "http://localhost:3001/api/auth";
    expect(
      await discover(
        {
          ...METADATA,
          authorization_endpoint: `${local}/oauth2/authorize`,
          token_endpoint: `${local}/oauth2/token`,
        },
        true,
      ),
    ).toBe(`${local}/oauth2/token`);
  });
});

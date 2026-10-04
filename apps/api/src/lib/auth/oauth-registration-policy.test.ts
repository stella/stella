import { describe, expect, test } from "bun:test";

import { getVerifiedOAuthOrigins } from "@/api/lib/auth/oauth-consent-info";
import {
  grantableScopes,
  OAUTH_REGISTRATION_SCOPE_POLICY,
  OPEN_REGISTRATION_SCOPES,
} from "@/api/lib/auth/oauth-registration-policy";

const ALL_SCOPES = Object.keys(OAUTH_REGISTRATION_SCOPE_POLICY);
const ELEVATED = ALL_SCOPES.filter(
  (scope) => !OPEN_REGISTRATION_SCOPES.includes(scope),
);
const policy = {
  verifiedOrigins: getVerifiedOAuthOrigins(["https://stella.example"]),
  providerScopes: ALL_SCOPES,
};

const registered = (scopes?: string[]) => ({
  clientId: "example-client",
  clientDiscoveryId: null,
  scopes,
});
const documented = (clientId: string, scopes?: string[]) => ({
  clientId,
  clientDiscoveryId: "cimd",
  scopes,
});

describe("grantableScopes", () => {
  test("a request naming no scope gets the open part of the client's list", () => {
    expect(grantableScopes(registered(ALL_SCOPES), undefined, policy)).toEqual(
      OPEN_REGISTRATION_SCOPES,
    );
    expect(grantableScopes(registered(), undefined, policy)).toEqual(
      OPEN_REGISTRATION_SCOPES,
    );
    expect(
      grantableScopes(
        registered(["stella:read", "stella:admin_write"]),
        undefined,
        policy,
      ),
    ).toEqual(["stella:read"]);
  });

  test("a request naming scopes keeps only the open ones for registered clients", () => {
    expect(
      grantableScopes(
        registered(ALL_SCOPES),
        ["openid", ...ELEVATED, "stella:read"],
        policy,
      ),
    ).toEqual(["openid", "stella:read"]);
    expect(grantableScopes(registered(ALL_SCOPES), [], policy)).toEqual([]);
  });

  test("only documented or first-party metadata documents keep every scope", () => {
    for (const [clientId, keeps] of [
      ["https://claude.ai/oauth/claude-code-client-metadata", true],
      ["https://chatgpt.com/oauth/client.json", true],
      ["https://stella.example/oauth/client.json", true],
      ["https://connector.example/oauth/client.json", false],
      ["https://claude.ai/oauth/other-client-metadata", false],
      ["https://user@stella.example/oauth/client.json", false],
      ["http://stella.example/oauth/client.json", false],
      ["not a url", false],
    ] as const) {
      const client = documented(clientId, ALL_SCOPES);
      const expected = keeps ? ALL_SCOPES : OPEN_REGISTRATION_SCOPES;
      expect(grantableScopes(client, undefined, policy), clientId).toEqual(
        expected,
      );
      expect(grantableScopes(client, ALL_SCOPES, policy), clientId).toEqual(
        expected,
      );
    }
  });

  test("a registered client using a documented location stays registered", () => {
    expect(grantableScopes(registered(ALL_SCOPES), ELEVATED, policy)).toEqual(
      [],
    );
    expect(
      grantableScopes(
        {
          clientId: "https://claude.ai/oauth/claude-code-client-metadata",
          clientDiscoveryId: null,
          scopes: ALL_SCOPES,
        },
        ELEVATED,
        policy,
      ),
    ).toEqual([]);
  });
});

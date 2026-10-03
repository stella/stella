import { describe, expect, test } from "bun:test";

import {
  getOAuthConsentInfo,
  getVerifiedOAuthOrigins,
} from "@/api/lib/oauth-consent-info";

const origins = getVerifiedOAuthOrigins([
  "https://stella.example",
  "http://localhost:3000",
]);

describe("OAuth consent app details", () => {
  test("uses registered redirect destinations", () => {
    expect(
      getOAuthConsentInfo(
        {
          clientId: "example-client",
          name: "Example connector",
          redirectUris: ["https://connector.example/callback"],
          clientDiscoveryId: null,
        },
        origins,
      ),
    ).toEqual({
      client_name: "Example connector",
      redirectHosts: ["connector.example"],
      clientIdHost: null,
      unverified: true,
    });
  });

  test("recognizes configured origins and keeps loopback apps unverified", () => {
    for (const [uri, unverified] of [
      ["https://stella.example/callback", false],
      ["http://localhost:3000/callback", true],
    ] as const) {
      expect(
        getOAuthConsentInfo(
          {
            clientId: "example-client",
            name: "Example connector",
            redirectUris: [uri],
            clientDiscoveryId: null,
          },
          origins,
        ).unverified,
      ).toBe(unverified);
    }
  });

  test("includes the discovered app identity", () => {
    expect(
      getOAuthConsentInfo(
        {
          clientId: "https://connector.example/client.json",
          name: "Example connector",
          redirectUris: ["https://connector.example/callback"],
          clientDiscoveryId: "cimd",
        },
        origins,
      ),
    ).toMatchObject({ clientIdHost: "connector.example", unverified: true });
  });
});

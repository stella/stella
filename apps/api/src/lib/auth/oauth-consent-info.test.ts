import { describe, expect, test } from "bun:test";

import {
  getOAuthConsentInfo,
  getVerifiedOAuthOrigins,
} from "@/api/lib/auth/oauth-consent-info";

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
      redirectTargets: ["connector.example"],
      clientIdHost: null,
      unverified: true,
      verifiedBrand: null,
    });
  });

  test("shows the scheme of private-use redirects next to http hosts", () => {
    expect(
      getOAuthConsentInfo(
        {
          clientId: "example-client",
          name: "Example connector",
          redirectUris: [
            "cursor://anysphere.cursor-mcp/oauth/callback",
            "com.example.app:/oauth/callback",
            "https://www.cursor.com/agents/mcp/oauth/callback",
            "http://localhost:8787/callback",
          ],
          clientDiscoveryId: null,
        },
        origins,
      ).redirectTargets,
    ).toEqual([
      "cursor://anysphere.cursor-mcp",
      "com.example.app:",
      "www.cursor.com",
      "localhost:8787",
    ]);
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

  const redirectUnverified = (uri: string) =>
    getOAuthConsentInfo(
      {
        clientId: "example-client",
        name: "Example connector",
        redirectUris: [uri],
        clientDiscoveryId: null,
      },
      origins,
    ).unverified;

  test("recognizes documented redirects of common assistants", () => {
    for (const uri of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector/oauth/abc123",
      "https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect",
      "https://global.consent.azure-apim.net/redirect",
      "https://global.consent.azure-apim.net/redirect/sample-connector-5f98284236",
      "https://vertexaisearch.cloud.google.com/oauth-redirect",
    ]) {
      expect(redirectUnverified(uri)).toBe(false);
    }
  });

  test("keeps every other location unverified", () => {
    for (const uri of [
      "https://claude.ai/api/mcp/other_callback",
      "https://claude.ai/api/mcp/auth_callback/",
      "https://claude.ai/api/mcp/auth_callback?next=1",
      "http://claude.ai/api/mcp/auth_callback",
      "https://claude.ai.example/api/mcp/auth_callback",
      "https://chatgpt.com/connector/oauth/",
      "https://chatgpt.com/connector/oauth/a/b",
      "https://chatgpt.com/connector/oauth/..",
      "https://chatgpt.com/connector/oauth/a%2Fb",
      "https://global.consent.azure-apim.net/other",
      "https://user@chatgpt.com/connector_platform_oauth_redirect",
    ]) {
      expect(redirectUnverified(uri)).toBe(true);
    }
  });

  test("an app is verified only when every redirect is", () => {
    expect(
      getOAuthConsentInfo(
        {
          clientId: "example-client",
          name: "Example connector",
          redirectUris: [
            "https://claude.ai/api/mcp/auth_callback",
            "https://connector.example/callback",
          ],
          clientDiscoveryId: null,
        },
        origins,
      ).unverified,
    ).toBe(true);
  });

  test("an app with one documented and one other redirect is unverified", () => {
    for (const documented of [
      "https://chatgpt.com/connector/oauth/abc123",
      "https://global.consent.azure-apim.net/redirect/abc123",
    ]) {
      expect(redirectUnverified(documented)).toBe(false);
      expect(
        getOAuthConsentInfo(
          {
            clientId: "example-client",
            name: "Example connector",
            redirectUris: [documented, "https://connector.example/callback"],
            clientDiscoveryId: null,
          },
          origins,
        ).unverified,
      ).toBe(true);
    }
  });

  test("an encoded separator never counts as one assigned segment", () => {
    for (const uri of [
      "https://chatgpt.com/connector/oauth/a%2Fb",
      "https://chatgpt.com/connector/oauth/a%2fb",
      "https://chatgpt.com/connector/oauth/%2F",
      "https://global.consent.azure-apim.net/redirect/a%2Fb",
      "https://global.consent.azure-apim.net/redirect/%2E%2E%2Fother",
    ]) {
      expect(redirectUnverified(uri)).toBe(true);
    }
  });

  test("recognizes documented client metadata documents", () => {
    for (const [clientId, unverified] of [
      ["https://claude.ai/oauth/claude-code-client-metadata", false],
      ["https://chatgpt.com/oauth/client.json", false],
      ["https://chatgpt.com/oauth/codex/client.json", false],
      ["https://chatgpt.com/oauth/codex/other.json", true],
      ["https://claude.ai/oauth/other-client-metadata", true],
    ] as const) {
      expect(
        getOAuthConsentInfo(
          {
            clientId,
            name: "Example connector",
            redirectUris: ["http://localhost/callback"],
            clientDiscoveryId: "cimd",
          },
          origins,
        ).unverified,
      ).toBe(unverified);
    }
  });

  const brandOf = (
    client: Partial<Parameters<typeof getOAuthConsentInfo>[0]>,
  ) =>
    getOAuthConsentInfo(
      {
        clientId: "example-client",
        name: "Example connector",
        redirectUris: [],
        clientDiscoveryId: null,
        ...client,
      },
      origins,
    ).verifiedBrand;

  test("brands a client only by its verified location", () => {
    for (const [redirectUri, brand] of [
      ["https://claude.ai/api/mcp/auth_callback", "claude"],
      ["https://chatgpt.com/connector_platform_oauth_redirect", "chatgpt"],
      ["https://chatgpt.com/connector/oauth/abc123", "chatgpt"],
      ["https://stella.example/callback", "stella"],
    ] as const) {
      expect(brandOf({ redirectUris: [redirectUri] })).toBe(brand);
    }
    for (const [clientId, brand] of [
      ["https://claude.ai/oauth/claude-code-client-metadata", "claude_code"],
      ["https://chatgpt.com/oauth/client.json", "chatgpt"],
      ["https://chatgpt.com/oauth/codex/client.json", "codex"],
      ["https://stella.example/oauth/cli.json", "stella"],
    ] as const) {
      expect(
        brandOf({
          clientId,
          redirectUris: ["http://127.0.0.1/callback"],
          clientDiscoveryId: "cimd",
        }),
      ).toBe(brand);
    }
  });

  test("an unverified client remains unverified when claiming a product name", () => {
    expect(
      getOAuthConsentInfo(
        {
          clientId: "example-client",
          name: "Claude",
          redirectUris: ["https://connector.example/callback"],
          clientDiscoveryId: null,
        },
        origins,
      ),
    ).toMatchObject({
      client_name: "Claude",
      unverified: true,
      verifiedBrand: null,
    });
  });

  test("a shared platform redirect verifies without naming a product", () => {
    for (const redirectUri of [
      "https://global.consent.azure-apim.net/redirect",
      "https://global.consent.azure-apim.net/redirect/independent-connector-1",
      "https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect",
      "https://vertexaisearch.cloud.google.com/oauth-redirect",
    ]) {
      expect(
        getOAuthConsentInfo(
          {
            clientId: "example-client",
            name: "Copilot Studio",
            redirectUris: [redirectUri],
            clientDiscoveryId: null,
          },
          origins,
        ),
      ).toMatchObject({ unverified: false, verifiedBrand: null });
    }
  });

  test("names no brand when verified evidence disagrees or is partial", () => {
    expect(
      brandOf({
        redirectUris: [
          "https://claude.ai/api/mcp/auth_callback",
          "https://chatgpt.com/connector_platform_oauth_redirect",
        ],
      }),
    ).toBeNull();
    expect(
      brandOf({
        redirectUris: [
          "https://claude.ai/api/mcp/auth_callback",
          "https://connector.example/callback",
        ],
      }),
    ).toBeNull();
    expect(brandOf({ redirectUris: [] })).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";

import {
  getOAuthConsentInfo,
  getVerifiedOAuthOrigins,
} from "@/api/lib/auth/oauth-consent-info";

const origins = getVerifiedOAuthOrigins([
  "https://stella.example",
  "http://localhost:3000",
]);

type ConsentInfoClient = Parameters<typeof getOAuthConsentInfo>[0];

const consentClientOf = (client: Partial<ConsentInfoClient>) =>
  getOAuthConsentInfo(
    {
      clientId: "example-client",
      name: "Example connector",
      redirectUris: [],
      clientDiscoveryId: null,
      ...client,
    },
    origins,
  ).client;

const redirectClient = (redirectUris: string[], name = "Example connector") =>
  consentClientOf({ redirectUris, name });

const documentClient = (clientId: string) =>
  consentClientOf({
    clientId,
    redirectUris: ["http://127.0.0.1/callback"],
    clientDiscoveryId: "cimd",
  });

const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CLAUDE_HOSTED_DOCUMENT =
  "https://claude.ai/oauth/mcp-oauth-client-metadata";

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
      client: { type: "unverified", name: "Example connector" },
      redirectTargets: ["connector.example"],
      clientIdHost: null,
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
    expect(redirectClient(["https://stella.example/callback"])).toEqual({
      type: "verified",
      brand: "stella",
    });
    expect(redirectClient(["http://localhost:3000/callback"]).type).toBe(
      "unverified",
    );
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
    ).toMatchObject({
      clientIdHost: "connector.example",
      client: { type: "unverified" },
    });
  });

  test("recognizes documented redirects of common assistants", () => {
    for (const uri of [
      CLAUDE_CALLBACK,
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector/oauth/abc123",
      "https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect",
      "https://global.consent.azure-apim.net/redirect",
      "https://global.consent.azure-apim.net/redirect/sample-connector-5f98284236",
      "https://vertexaisearch.cloud.google.com/oauth-redirect",
    ]) {
      expect(redirectClient([uri]).type, uri).not.toBe("unverified");
    }
  });

  test("a documented redirect matches only as written", () => {
    for (const uri of [
      // Path: other, longer, shorter, trailing slash, case, encoded.
      "https://claude.ai/api/mcp/other_callback",
      "https://claude.ai/api/mcp/auth_callback/",
      "https://claude.ai/api/mcp/auth_callback/extra",
      "https://claude.ai/api/mcp/auth_callbackx",
      "https://claude.ai/api/mcp/auth",
      "https://claude.ai/api/mcp/Auth_Callback",
      "https://claude.ai/api/mcp/auth%5Fcallback",
      // Query and fragment.
      "https://claude.ai/api/mcp/auth_callback?next=1",
      "https://claude.ai/api/mcp/auth_callback#next",
      // Scheme and port.
      "http://claude.ai/api/mcp/auth_callback",
      "https://claude.ai:8443/api/mcp/auth_callback",
      // Host: lookalike suffix, prefix, subdomain, trailing dot.
      "https://claude.ai.example/api/mcp/auth_callback",
      "https://evilclaude.ai/api/mcp/auth_callback",
      "https://www.claude.ai/api/mcp/auth_callback",
      "https://claude.ai./api/mcp/auth_callback",
      "https://connector.example/https://claude.ai/api/mcp/auth_callback",
      // Userinfo.
      "https://user@claude.ai/api/mcp/auth_callback",
      "https://claude.ai@connector.example/api/mcp/auth_callback",
      "https://user:secret@chatgpt.com/connector_platform_oauth_redirect",
      // One assigned segment, exactly.
      "https://chatgpt.com/connector/oauth/",
      "https://chatgpt.com/connector/oauth/a/b",
      "https://chatgpt.com/connector/oauth/..",
      "https://global.consent.azure-apim.net/other",
      "not a url",
    ]) {
      expect(redirectClient([uri], "Claude"), uri).toEqual({
        type: "unverified",
        name: "Claude",
      });
    }
  });

  test("the host compares as the URL standard normalizes it", () => {
    // The browser follows these to the same place as the documented form.
    for (const uri of [
      "https://CLAUDE.AI/api/mcp/auth_callback",
      "https://claude.ai:443/api/mcp/auth_callback",
    ]) {
      expect(redirectClient([uri]), uri).toEqual({
        type: "verified",
        brand: "claude",
      });
    }
  });

  test("an app with one documented and one other redirect is unverified", () => {
    for (const documented of [
      CLAUDE_CALLBACK,
      "https://chatgpt.com/connector/oauth/abc123",
      "https://global.consent.azure-apim.net/redirect/abc123",
      "https://stella.example/callback",
    ]) {
      expect(redirectClient([documented]).type).not.toBe("unverified");
      for (const redirectUris of [
        [documented, "https://connector.example/callback"],
        ["https://connector.example/callback", documented],
        [documented, "http://localhost:51001/callback"],
      ]) {
        expect(redirectClient(redirectUris, "Claude")).toEqual({
          type: "unverified",
          name: "Claude",
        });
      }
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
      expect(redirectClient([uri]).type, uri).toBe("unverified");
    }
  });

  test("brands a client only by its verified location", () => {
    for (const [redirectUri, brand] of [
      [CLAUDE_CALLBACK, "claude"],
      ["https://chatgpt.com/connector_platform_oauth_redirect", "chatgpt"],
      ["https://chatgpt.com/connector/oauth/abc123", "chatgpt"],
      ["https://stella.example/callback", "stella"],
    ] as const) {
      expect(redirectClient([redirectUri])).toEqual({
        type: "verified",
        brand,
      });
    }
    for (const [clientId, brand] of [
      [CLAUDE_HOSTED_DOCUMENT, "claude"],
      ["https://claude.ai/oauth/claude-code-client-metadata", "claude_code"],
      ["https://chatgpt.com/oauth/client.json", "chatgpt"],
      ["https://chatgpt.com/oauth/codex/client.json", "codex"],
      ["https://stella.example/oauth/cli.json", "stella"],
    ] as const) {
      expect(documentClient(clientId), clientId).toEqual({
        type: "verified",
        brand,
      });
    }
  });

  test("a metadata document is verified only at its documented URL", () => {
    for (const clientId of [
      `${CLAUDE_HOSTED_DOCUMENT}/`,
      `${CLAUDE_HOSTED_DOCUMENT}?v=1`,
      `${CLAUDE_HOSTED_DOCUMENT}#v1`,
      "https://claude.ai/oauth/other-client-metadata",
      "https://claude.ai.example/oauth/mcp-oauth-client-metadata",
      "https://user@claude.ai/oauth/mcp-oauth-client-metadata",
      "http://claude.ai/oauth/mcp-oauth-client-metadata",
      "https://chatgpt.com/oauth/codex/other.json",
    ]) {
      expect(documentClient(clientId).type, clientId).toBe("unverified");
    }
  });

  test("a metadata document client is judged by its document, not its redirects", () => {
    expect(
      consentClientOf({
        clientId: "https://connector.example/client.json",
        name: "Claude",
        redirectUris: [CLAUDE_CALLBACK],
        clientDiscoveryId: "cimd",
      }),
    ).toEqual({ type: "unverified", name: "Claude" });
  });

  test("a verified client carries no registered name", () => {
    expect(redirectClient([CLAUDE_CALLBACK], "Not Claude")).toEqual({
      type: "verified",
      brand: "claude",
    });
  });

  test("an unverified client remains unverified when claiming a product name", () => {
    for (const name of ["Claude", "Claude Code", "ChatGPT", "stella"]) {
      expect(
        redirectClient(["https://connector.example/callback"], name),
      ).toEqual({ type: "unverified", name });
    }
  });

  test("an empty registered name is no name", () => {
    expect(redirectClient(["https://connector.example/callback"], "")).toEqual({
      type: "unverified",
      name: null,
    });
  });

  test("a shared platform redirect verifies without naming a product", () => {
    for (const redirectUri of [
      "https://global.consent.azure-apim.net/redirect",
      "https://global.consent.azure-apim.net/redirect/independent-connector-1",
      "https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect",
      "https://vertexaisearch.cloud.google.com/oauth-redirect",
    ]) {
      expect(redirectClient([redirectUri], "Copilot Studio")).toEqual({
        type: "verified_unbranded",
        name: "Copilot Studio",
      });
    }
  });

  test("names no brand when verified evidence disagrees or is absent", () => {
    expect(
      redirectClient([
        CLAUDE_CALLBACK,
        "https://chatgpt.com/connector_platform_oauth_redirect",
      ]),
    ).toEqual({ type: "verified_unbranded", name: "Example connector" });
    expect(redirectClient([])).toEqual({
      type: "unverified",
      name: "Example connector",
    });
  });
});

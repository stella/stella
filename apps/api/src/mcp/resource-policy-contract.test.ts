import { describe, expect, test } from "bun:test";

import { MCP_OAUTH_PROTOCOL_SCOPES } from "@stll/api-contract";

import {
  buildBetterAuthOAuthResources,
  getMcpResourceScopes,
  LEGAL_RESOLVE_RESOURCE_ROUTES,
  MCP_MODES,
  normalizeBetterAuthOAuthBaseUrl,
} from "@/api/mcp/resource-policy-contract";

describe("Better Auth OAuth resource policy contract", () => {
  test("declares every REST route sharing the law resource and its scope", () => {
    expect(LEGAL_RESOLVE_RESOURCE_ROUTES).toEqual({
      decision: {
        path: "/case/:country/decisions/resolve",
        requiredScope: "stella:law_read",
      },
      law: {
        path: "/law/:country/citations/resolve",
        requiredScope: "stella:law_read",
      },
    });
  });
  test("preserves protocol scopes in every grant without advertising them as resource scopes", () => {
    const resources = buildBetterAuthOAuthResources("https://api.stll.app");
    for (const [index, mode] of MCP_MODES.entries()) {
      const resource = resources.at(index);
      expect(resource?.allowedScopes).toEqual([
        ...getMcpResourceScopes(mode),
        ...MCP_OAUTH_PROTOCOL_SCOPES,
      ]);
      for (const protocolScope of MCP_OAUTH_PROTOCOL_SCOPES) {
        expect(getMcpResourceScopes(mode)).not.toContain(protocolScope);
      }
    }
  });

  test("derives every resource from an explicit origin", () => {
    expect(
      buildBetterAuthOAuthResources("https://api.stll.app").map(
        ({ identifier }) => identifier,
      ),
    ).toEqual([
      "https://api.stll.app/mcp",
      "https://api.stll.app/mcp-documents",
      "https://api.stll.app/mcp-anonymized",
      "https://api.stll.app/mcp-law",
    ]);
  });

  test("accepts only a credential-free HTTPS origin", () => {
    expect(normalizeBetterAuthOAuthBaseUrl("https://api.stll.app/")).toBe(
      "https://api.stll.app",
    );
    for (const value of [
      "http://api.stll.app",
      "https://user:secret@api.stll.app",
      "https://api.stll.app/path",
      "https://api.stll.app?query=1",
      "https://api.stll.app#fragment",
      "not-a-url",
    ]) {
      expect(normalizeBetterAuthOAuthBaseUrl(value)).toBeNull();
    }
  });
});

import { describe, expect, test } from "bun:test";

import { MCP_OAUTH_PROTOCOL_SCOPES } from "@stll/api-contract";
import {
  API_OAUTH_RESOURCE_NAME,
  API_OAUTH_RESOURCE_SCOPES,
} from "@stll/api-contract/api-oauth-resource";

import {
  buildApiOAuthResource,
  buildBetterAuthOAuthResources,
  buildEveryClientOAuthResources,
  getMcpResourceScopes,
  isEveryClientOAuthResource,
  LEGAL_RESOLVE_RESOURCE_ROUTES,
  MCP_MODES,
  MCP_RESOURCE_MODE_CONFIG,
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
      ...MCP_MODES.map((mode) =>
        new URL(
          MCP_RESOURCE_MODE_CONFIG[mode].httpPath,
          "https://api.stll.app",
        ).toString(),
      ),
      "https://api.stll.app/v1",
    ]);
  });

  test("links every client to the MCP audiences and only them", () => {
    const origin = "https://api.stll.app";
    const everyClient = buildEveryClientOAuthResources(origin);
    const api = buildApiOAuthResource(origin);
    expect(buildBetterAuthOAuthResources(origin)).toEqual([
      ...everyClient,
      api,
    ]);
    expect(everyClient.map(({ identifier }) => identifier)).not.toContain(
      api.identifier,
    );
    for (const resource of buildBetterAuthOAuthResources(origin)) {
      expect(isEveryClientOAuthResource(resource)).toBe(
        resource.identifier !== api.identifier,
      );
    }
  });

  test("the API resource is told apart however the deployment's base URL is shaped", () => {
    // A base under a path moves the identifier; the classification holds.
    for (const base of [
      "https://host.example",
      "https://host.example/stella",
    ]) {
      const resources = buildBetterAuthOAuthResources(base);
      expect(
        resources.filter((resource) => !isEveryClientOAuthResource(resource)),
      ).toEqual([buildApiOAuthResource(base)]);
    }
  });

  test("the API resource grants its route scopes plus the protocol scopes", () => {
    expect(buildApiOAuthResource("https://api.stll.app")).toEqual({
      allowedScopes: [
        ...API_OAUTH_RESOURCE_SCOPES,
        ...MCP_OAUTH_PROTOCOL_SCOPES,
      ],
      identifier: "https://api.stll.app/v1",
      name: API_OAUTH_RESOURCE_NAME,
    });
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

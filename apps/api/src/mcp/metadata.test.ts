import { describe, expect, test } from "bun:test";

import { getAuthIssuerUrl } from "@/api/lib/auth-paths";
import {
  MCP_ANONYMIZED_RESOURCE_SCOPES,
  getMcpProtectedResourceMetadataUrl,
  getMcpResourceUrl,
} from "@/api/mcp/constants";
import {
  createMcpCorsHeaders,
  createMcpMetadataHeaders,
  getMcpProtectedResourceMetadata,
  getMcpWwwAuthenticateHeader,
} from "@/api/mcp/metadata";

describe("MCP protected resource metadata", () => {
  test("advertises stella's MCP resource and supported scopes", () => {
    expect(getMcpProtectedResourceMetadata()).toEqual({
      authorization_servers: [getAuthIssuerUrl()],
      bearer_methods_supported: ["header"],
      resource: getMcpResourceUrl(),
      scopes_supported: ["stella:search", "stella:read"],
    });
  });

  test("advertises anonymized MCP metadata on the separate resource", () => {
    expect(getMcpProtectedResourceMetadata("anonymized")).toEqual({
      authorization_servers: [getAuthIssuerUrl()],
      bearer_methods_supported: ["header"],
      resource: getMcpResourceUrl("anonymized"),
      scopes_supported: [...MCP_ANONYMIZED_RESOURCE_SCOPES],
    });
  });

  test("returns browser-friendly discovery headers", () => {
    const headers = createMcpMetadataHeaders();

    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
    expect(headers.get("Access-Control-Allow-Headers")).toBe(
      "Authorization, Content-Type, MCP-Protocol-Version",
    );
    expect(headers.get("Access-Control-Expose-Headers")).toBe(
      "WWW-Authenticate",
    );
  });

  test("returns browser-friendly MCP transport headers", () => {
    const headers = createMcpCorsHeaders();

    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, DELETE, OPTIONS",
    );
  });

  test("points WWW-Authenticate at the path-specific protected resource metadata URL", () => {
    expect(getMcpWwwAuthenticateHeader()).toBe(
      `Bearer resource_metadata="${getMcpProtectedResourceMetadataUrl()}"`,
    );
  });

  test("points anonymized WWW-Authenticate at the anonymized metadata URL", () => {
    expect(getMcpWwwAuthenticateHeader("anonymized")).toBe(
      `Bearer resource_metadata="${getMcpProtectedResourceMetadataUrl("anonymized")}"`,
    );
  });
});

import { describe, expect, test } from "bun:test";

import { getAuthIssuerUrl } from "@/api/lib/auth-paths";
import {
  MCP_ANONYMIZED_RESOURCE_SCOPES,
  MCP_DEFAULT_RESOURCE_SCOPES,
  getMcpProtectedResourceMetadataUrl,
  getMcpResourceUrl,
  STELLA_CLI_LATEST_VERSION,
  STELLA_CLI_MAXIMUM_VERSION,
  STELLA_CLI_MINIMUM_VERSION,
  STELLA_MCP_API_CONTRACT_VERSION,
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
      scopes_supported: [...MCP_DEFAULT_RESOURCE_SCOPES],
      stella_compatibility: {
        api_contract_version: STELLA_MCP_API_CONTRACT_VERSION,
        cli_version: {
          maximum: STELLA_CLI_MAXIMUM_VERSION,
          minimum: STELLA_CLI_MINIMUM_VERSION,
        },
      },
    });
  });

  test("advertises anonymized MCP metadata on the separate resource", () => {
    expect(getMcpProtectedResourceMetadata("anonymized")).toEqual({
      authorization_servers: [getAuthIssuerUrl()],
      bearer_methods_supported: ["header"],
      resource: getMcpResourceUrl("anonymized"),
      scopes_supported: [...MCP_ANONYMIZED_RESOURCE_SCOPES],
      stella_compatibility: {
        api_contract_version: STELLA_MCP_API_CONTRACT_VERSION,
        cli_version: {
          maximum: STELLA_CLI_MAXIMUM_VERSION,
          minimum: STELLA_CLI_MINIMUM_VERSION,
        },
      },
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
      "WWW-Authenticate, x-stella-api-contract-version, x-stella-cli-minimum, x-stella-cli-latest, x-request-id",
    );
    expect(headers.get("x-stella-api-contract-version")).toBe("1");
    expect(headers.get("x-stella-cli-minimum")).toBe(
      STELLA_CLI_MINIMUM_VERSION,
    );
    expect(headers.get("x-stella-cli-latest")).toBe(STELLA_CLI_LATEST_VERSION);
  });

  test("returns browser-friendly MCP transport headers", () => {
    const headers = createMcpCorsHeaders();

    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, DELETE, OPTIONS",
    );
    expect(headers.get("x-stella-api-contract-version")).toBe("1");
    expect(headers.get("x-stella-cli-minimum")).toBe(
      STELLA_CLI_MINIMUM_VERSION,
    );
    expect(headers.get("x-stella-cli-latest")).toBe(STELLA_CLI_LATEST_VERSION);
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

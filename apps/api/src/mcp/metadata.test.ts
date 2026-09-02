import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { getAuthIssuerUrl } from "@/api/lib/auth-paths";
import {
  MCP_ANONYMIZED_RESOURCE_SCOPES,
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_STATELESS_ALLOW_HEADER,
  STELLA_API_CONTRACT,
  getMcpProtectedResourceMetadataUrl,
  getMcpResourceUrl,
  STELLA_CLI_MAXIMUM_VERSION,
  STELLA_CLI_MINIMUM_VERSION,
  STELLA_MCP_API_CONTRACT_VERSION,
} from "@/api/mcp/constants";
import {
  createMcpCorsHeaders,
  createMcpDiscoveryPreflightHeaders,
  createMcpMetadataHeaders,
  createMcpPreflightHeaders,
  getMcpProtectedResourceMetadata,
  getMcpWwwAuthenticateHeader,
} from "@/api/mcp/metadata";

describe("MCP protected resource metadata", () => {
  test("advertises stella's MCP resource and supported scopes", () => {
    expect(getMcpProtectedResourceMetadata()).toEqual({
      authorization_servers: [getAuthIssuerUrl()],
      bearer_methods_supported: ["header"],
      resource: getMcpResourceUrl(),
      resource_name: "stella",
      resource_logo_uri: new URL(
        "favicon.svg",
        `${env.FRONTEND_URL.replace(/\/$/u, "")}/`,
      ).toString(),
      scopes_supported: [...MCP_DEFAULT_RESOURCE_SCOPES],
      stella_contract: {
        capabilities: { ...STELLA_API_CONTRACT.capabilities },
        protocol: STELLA_API_CONTRACT.protocol,
        revision: STELLA_API_CONTRACT.revision,
      },
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
      resource_name: "stella",
      resource_logo_uri: new URL(
        "favicon.svg",
        `${env.FRONTEND_URL.replace(/\/$/u, "")}/`,
      ).toString(),
      scopes_supported: [...MCP_ANONYMIZED_RESOURCE_SCOPES],
      stella_contract: {
        capabilities: { ...STELLA_API_CONTRACT.capabilities },
        protocol: STELLA_API_CONTRACT.protocol,
        revision: STELLA_API_CONTRACT.revision,
      },
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
      "WWW-Authenticate, x-stella-api-contract-version, x-stella-cli-minimum, x-stella-organization, x-stella-scopes, x-stella-scope-omitted-tools, x-stella-feature-omitted-tools, x-request-id",
    );
    expect(headers.get("x-stella-api-contract-version")).toBe("1");
    expect(headers.get("x-stella-cli-minimum")).toBe(
      STELLA_CLI_MINIMUM_VERSION,
    );
    expect(headers.get("x-stella-cli-latest")).toBeNull();
  });

  test("returns browser-friendly MCP transport headers", () => {
    const headers = createMcpCorsHeaders();

    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Access-Control-Allow-Methods")).toBe(
      MCP_STATELESS_ALLOW_HEADER,
    );
    expect(headers.get("x-stella-api-contract-version")).toBe("1");
    expect(headers.get("x-stella-cli-minimum")).toBe(
      STELLA_CLI_MINIMUM_VERSION,
    );
    expect(headers.get("x-stella-cli-latest")).toBeNull();
  });

  test("owns the transport preflight it advertises", () => {
    const headers = createMcpPreflightHeaders();

    expect(headers.get("Allow")).toBe(MCP_STATELESS_ALLOW_HEADER);
    expect(headers.get("Access-Control-Allow-Methods")).toBe(
      MCP_STATELESS_ALLOW_HEADER,
    );
    // A bearer-only endpoint answered with `Allow-Origin: *` must never claim
    // to accept credentials: browsers refuse the pairing outright.
    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("owns the discovery preflight it advertises", () => {
    const headers = createMcpDiscoveryPreflightHeaders();

    expect(headers.get("Allow")).toBe("GET, OPTIONS");
    expect(headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
    expect(headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("points WWW-Authenticate at the path-specific protected resource metadata URL", () => {
    expect(getMcpWwwAuthenticateHeader()).toBe(
      `Bearer resource_metadata="${getMcpProtectedResourceMetadataUrl()}"`,
    );
  });

  test("points anonymized WWW-Authenticate at the anonymized metadata URL", () => {
    expect(getMcpWwwAuthenticateHeader({ mode: "anonymized" })).toBe(
      `Bearer resource_metadata="${getMcpProtectedResourceMetadataUrl("anonymized")}"`,
    );
  });

  test("reports a rejected token with the RFC 6750 error code", () => {
    expect(getMcpWwwAuthenticateHeader({ error: "invalid_token" })).toBe(
      `Bearer error="invalid_token", error_description="The access token is expired, revoked, or not valid for this resource", resource_metadata="${getMcpProtectedResourceMetadataUrl()}"`,
    );
  });

  test("omits the error code when the request presented no credentials", () => {
    // RFC 6750 §3.1: a client that sent nothing must not read the challenge as
    // a rejection of credentials it never presented.
    expect(getMcpWwwAuthenticateHeader({ error: "none" })).not.toContain(
      "error=",
    );
  });
});

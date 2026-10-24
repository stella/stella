import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { env } from "@/api/env";
import { getAuthIssuerUrl } from "@/api/lib/auth/auth-paths";
import {
  getMcpProtectedResourceMetadataUrl,
  getMcpResourceUrl,
  MCP_ADVANCED_RESOURCE_SCOPES,
  MCP_ANONYMIZED_RESOURCE_SCOPES,
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_DISCOVERY_ALLOWED_HEADERS,
  MCP_LAW_RESOURCE_SCOPES,
  MCP_STATELESS_ALLOW_HEADER,
  STELLA_API_CONTRACT,
  STELLA_CLI_LATEST_VERSION,
  STELLA_CLI_MINIMUM_VERSION,
  STELLA_MCP_API_CONTRACT_VERSION,
} from "@/api/mcp/constants";
import {
  createMcpCorsHeaders,
  createMcpDiscoveryPreflightHeaders,
  createMcpMetadataHeaders,
  createMcpPreflightHeaders,
  getMcpLogoUri,
  getMcpProtectedResourceMetadata,
  getMcpServerIcons,
  getMcpWwwAuthenticateHeader,
  MCP_LOGO_PATH,
} from "@/api/mcp/metadata";

describe("MCP protected resource metadata", () => {
  test("advertises stella's MCP resource and supported scopes", () => {
    expect(getMcpProtectedResourceMetadata()).toEqual({
      authorization_servers: [getAuthIssuerUrl()],
      bearer_methods_supported: ["header"],
      resource: getMcpResourceUrl(),
      resource_name: "stella",
      resource_logo_uri: new URL(
        "stella-logo-512.png",
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
          maximum: STELLA_CLI_LATEST_VERSION,
          minimum: STELLA_CLI_MINIMUM_VERSION,
        },
      },
    });
  });

  test("default and advanced challenges point to metadata with their exact grant scopes", () => {
    for (const [mode, scopes] of [
      ["default", MCP_DEFAULT_RESOURCE_SCOPES],
      ["advanced", MCP_ADVANCED_RESOURCE_SCOPES],
    ] as const) {
      expect(getMcpWwwAuthenticateHeader({ mode })).toBe(
        `Bearer resource_metadata="${getMcpProtectedResourceMetadataUrl(mode)}"`,
      );
      expect(getMcpProtectedResourceMetadata(mode).scopes_supported).toEqual([
        ...scopes,
      ]);
    }
  });

  test("keeps external gateway consent on the advanced resource", () => {
    expect(getMcpProtectedResourceMetadata().scopes_supported).not.toContain(
      "stella:external_mcps",
    );
    expect(
      getMcpProtectedResourceMetadata("advanced").scopes_supported,
    ).toEqual([...MCP_ADVANCED_RESOURCE_SCOPES]);
    expect(getMcpResourceUrl("advanced")).toEndWith("/mcp/advanced");
    expect(getMcpProtectedResourceMetadataUrl("advanced")).toEndWith(
      "/.well-known/oauth-protected-resource/mcp/advanced",
    );
  });

  test("advertises anonymized MCP metadata on the separate resource", () => {
    expect(getMcpProtectedResourceMetadata("anonymized")).toEqual({
      authorization_servers: [getAuthIssuerUrl()],
      bearer_methods_supported: ["header"],
      resource: getMcpResourceUrl("anonymized"),
      resource_name: "stella",
      resource_logo_uri: new URL(
        "stella-logo-512.png",
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
          maximum: STELLA_CLI_LATEST_VERSION,
          minimum: STELLA_CLI_MINIMUM_VERSION,
        },
      },
    });
  });

  test("advertises the scopes derived for the law MCP resource", () => {
    expect(getMcpProtectedResourceMetadata("law")).toEqual({
      authorization_servers: [getAuthIssuerUrl()],
      bearer_methods_supported: ["header"],
      resource: getMcpResourceUrl("law"),
      resource_name: "stella",
      resource_logo_uri: new URL(
        "stella-logo-512.png",
        `${env.FRONTEND_URL.replace(/\/$/u, "")}/`,
      ).toString(),
      scopes_supported: MCP_LAW_RESOURCE_SCOPES,
      stella_contract: {
        capabilities: { ...STELLA_API_CONTRACT.capabilities },
        protocol: STELLA_API_CONTRACT.protocol,
        revision: STELLA_API_CONTRACT.revision,
      },
      stella_compatibility: {
        api_contract_version: STELLA_MCP_API_CONTRACT_VERSION,
        cli_version: {
          maximum: STELLA_CLI_LATEST_VERSION,
          minimum: STELLA_CLI_MINIMUM_VERSION,
        },
      },
    });
    // The public-corpus audience carries no write grant and no anonymized
    // pairing, so the advertised list is exactly its three read grants.
    expect(MCP_LAW_RESOURCE_SCOPES).toEqual([
      "stella:search",
      "stella:read",
      "stella:law_read",
    ]);
  });

  test("resolves the law resource and its discovery document on /mcp-law", () => {
    expect(getMcpResourceUrl("law")).toEndWith("/mcp-law");
    expect(getMcpProtectedResourceMetadataUrl("law")).toEndWith(
      "/.well-known/oauth-protected-resource/mcp-law",
    );
  });

  test("returns browser-friendly discovery headers", () => {
    const headers = createMcpMetadataHeaders();

    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
    expect(headers.get("Access-Control-Allow-Headers")).toBe(
      MCP_DISCOVERY_ALLOWED_HEADERS.join(", "),
    );
    expect(headers.get("Access-Control-Expose-Headers")).toBe(
      "WWW-Authenticate, x-stella-api-contract-version, x-stella-cli-minimum, x-stella-cli-latest, x-stella-organization, x-stella-scopes, x-stella-scope-omitted-tools, x-stella-feature-omitted-tools, x-stella-feature-omitted-capabilities, x-request-id",
    );
    expect(headers.get("x-stella-api-contract-version")).toBe(
      String(STELLA_MCP_API_CONTRACT_VERSION),
    );
    expect(headers.get("x-stella-cli-minimum")).toBe(
      STELLA_CLI_MINIMUM_VERSION,
    );
    expect(headers.get("x-stella-cli-latest")).toBe(STELLA_CLI_LATEST_VERSION);
    expect(headers.get("Cache-Control")).toBeNull();
  });

  test("returns browser-friendly MCP transport headers", () => {
    const headers = createMcpCorsHeaders();

    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Access-Control-Allow-Methods")).toBe(
      MCP_STATELESS_ALLOW_HEADER,
    );
    expect(headers.get("x-stella-api-contract-version")).toBe(
      String(STELLA_MCP_API_CONTRACT_VERSION),
    );
    expect(headers.get("x-stella-cli-minimum")).toBe(
      STELLA_CLI_MINIMUM_VERSION,
    );
    expect(headers.get("x-stella-cli-latest")).toBe(STELLA_CLI_LATEST_VERSION);
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

describe("MCP logo", () => {
  // Hosts that list the connector do not all render SVG, so the advertised
  // logo must be a PNG the web app actually serves at its advertised size.
  test("is a 512x512 PNG served from the web app's public assets", () => {
    const logoFile = path.resolve(
      import.meta.dir,
      "../../../web/public/stella-logo-512.png",
    );
    expect(path.basename(logoFile)).toBe(MCP_LOGO_PATH);
    const bytes = readFileSync(logoFile);
    expect([...bytes.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(bytes.readUInt32BE(16)).toBe(512);
    expect(bytes.readUInt32BE(20)).toBe(512);
  });

  test("PRM and serverInfo icons advertise the same PNG", () => {
    const logoUri = getMcpLogoUri();
    expect(new URL(logoUri).pathname).toBe(`/${MCP_LOGO_PATH}`);
    for (const mode of [
      "default",
      "advanced",
      "documents",
      "anonymized",
      "law",
    ] as const) {
      expect(getMcpProtectedResourceMetadata(mode).resource_logo_uri).toBe(
        logoUri,
      );
    }
    expect(getMcpServerIcons()).toEqual([
      { mimeType: "image/png", sizes: ["512x512"], src: logoUri },
    ]);
  });
});

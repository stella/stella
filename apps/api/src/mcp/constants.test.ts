import { describe, expect, test } from "bun:test";

import {
  getMcpResourceScopes,
  MCP_ALL_RESOURCE_SCOPES,
  MCP_ANONYMIZED_RESOURCE_SCOPES,
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_OAUTH_SCOPES,
} from "@/api/mcp/constants";

describe("MCP OAuth scope surface", () => {
  test("offline_access is grantable through the OAuth provider", () => {
    expect(MCP_OAUTH_SCOPES).toContain("offline_access");
  });

  // offline_access is a protocol scope (RFC 6749), not a stella resource
  // scope: it must never leak into the resource-scope lists that back MCP
  // tool definitions and protected-resource metadata, since it grants no
  // access to any stella resource by itself.
  test("offline_access is not a stella resource scope", () => {
    expect(MCP_ALL_RESOURCE_SCOPES).not.toContain("offline_access");
    expect(MCP_DEFAULT_RESOURCE_SCOPES).not.toContain("offline_access");
    expect(MCP_ANONYMIZED_RESOURCE_SCOPES).not.toContain("offline_access");
  });

  test("resource metadata scope lists exclude offline_access in both modes", () => {
    expect(getMcpResourceScopes("default")).not.toContain("offline_access");
    expect(getMcpResourceScopes("anonymized")).not.toContain("offline_access");
  });
});

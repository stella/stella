import { describe, expect, test } from "bun:test";

import { getAuthIssuerUrl } from "@/api/lib/auth-paths";
import {
  extractMcpSession,
  getMcpAccessTokenVerificationOptions,
} from "@/api/mcp/auth";
import { getMcpResourceUrl } from "@/api/mcp/constants";

describe("extractMcpSession", () => {
  test("uses explicit auth endpoints for MCP access token verification", () => {
    expect(getMcpAccessTokenVerificationOptions()).toEqual({
      jwksUrl: `${getAuthIssuerUrl()}/jwks`,
      verifyOptions: {
        audience: getMcpResourceUrl(),
        issuer: getAuthIssuerUrl(),
      },
    });
  });

  test("uses the anonymized MCP resource audience for anonymized verification", () => {
    expect(getMcpAccessTokenVerificationOptions("anonymized")).toEqual({
      jwksUrl: `${getAuthIssuerUrl()}/jwks`,
      verifyOptions: {
        audience: getMcpResourceUrl("anonymized"),
        issuer: getAuthIssuerUrl(),
      },
    });
  });

  test("builds an MCP session from OAuth resource token claims", () => {
    expect(
      extractMcpSession({
        org_id: "org_123",
        scope: "stella:read stella:search",
        sub: "user_123",
      }),
    ).toEqual({
      organizationId: "org_123",
      scopes: ["stella:read", "stella:search"],
      userId: "user_123",
    });
  });

  test("rejects tokens without a user subject", () => {
    expect(() =>
      extractMcpSession({
        org_id: "org_123",
        scope: "stella:read",
      }),
    ).toThrow("Token missing sub claim");
  });

  test("rejects tokens without an organization claim", () => {
    expect(() =>
      extractMcpSession({
        scope: "stella:read",
        sub: "user_123",
      }),
    ).toThrow("Token missing org_id claim");
  });
});

import { describe, expect, test } from "bun:test";

import { getAuthIssuerUrl } from "@/api/lib/auth-paths";
import {
  classifyMcpTokenVerificationError,
  extractMcpSession,
  getMcpAccessTokenVerificationOptions,
} from "@/api/mcp/auth";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import {
  McpAuthenticationError,
  McpTokenVerificationError,
} from "@/api/mcp/errors";

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

  test("preserves a server-issued workspace attenuation", () => {
    expect(
      extractMcpSession({
        org_id: "org_123",
        scope: "stella:read",
        sub: "user_123",
        workspace_ids: ["workspace_1"],
      }).workspaceIds,
    ).toEqual(["workspace_1"]);
  });

  test("rejects a malformed workspace attenuation", () => {
    expect(() =>
      extractMcpSession({
        org_id: "org_123",
        scope: "stella:read",
        sub: "user_123",
        workspace_ids: ["workspace_1", 42],
      }),
    ).toThrow("Token has invalid workspace_ids claim");
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

describe("classifyMcpTokenVerificationError", () => {
  test("maps an UNAUTHORIZED verifier error to a token rejection", () => {
    // Shape of a better-call APIError as re-thrown by the resource client for a
    // genuinely invalid/expired token.
    const apiError = Object.assign(new Error("token expired"), {
      name: "APIError",
      status: "UNAUTHORIZED",
      statusCode: 401,
    });

    const classified = classifyMcpTokenVerificationError(apiError);

    expect(classified).toBeInstanceOf(McpAuthenticationError);
    expect(classified.cause).toBe(apiError);
  });

  test("keeps a claim-extraction rejection as an authentication error", () => {
    const claimError = new McpAuthenticationError({
      message: "Token missing org_id claim",
    });

    expect(classifyMcpTokenVerificationError(claimError)).toBe(claimError);
  });

  test("returns an existing verification error as-is (idempotent)", () => {
    const verificationError = new McpTokenVerificationError({
      message: "Token verification is temporarily unavailable",
    });

    expect(classifyMcpTokenVerificationError(verificationError)).toBe(
      verificationError,
    );
  });

  test("maps a JWKS fetch outage to a retryable verification error", () => {
    // `verifyAccessToken` re-throws a JWKS fetch/network failure as a plain
    // Error (no UNAUTHORIZED status), so it must not present as a bad token.
    const jwksError = new Error("Jwks failed: fetch failed");

    const classified = classifyMcpTokenVerificationError(jwksError);

    expect(classified).toBeInstanceOf(McpTokenVerificationError);
    expect(classified).not.toBeInstanceOf(McpAuthenticationError);
    expect(classified.cause).toBe(jwksError);
  });

  test("maps a non-UNAUTHORIZED APIError to a retryable verification error", () => {
    const internalError = Object.assign(new Error("introspection failed"), {
      name: "APIError",
      status: "INTERNAL_SERVER_ERROR",
      statusCode: 500,
    });

    expect(classifyMcpTokenVerificationError(internalError)).toBeInstanceOf(
      McpTokenVerificationError,
    );
  });
});

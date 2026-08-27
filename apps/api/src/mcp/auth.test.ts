import { describe, expect, test } from "bun:test";

import { getAuthIssuerUrl } from "@/api/lib/auth-paths";
import {
  classifyMcpTokenVerificationError,
  extractMcpSession,
  getMcpAccessTokenVerificationOptions,
  isMcpSession,
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

  test("uses the documents MCP resource audience for document verification", () => {
    expect(getMcpAccessTokenVerificationOptions("documents")).toEqual({
      jwksUrl: `${getAuthIssuerUrl()}/jwks`,
      verifyOptions: {
        audience: getMcpResourceUrl("documents"),
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
      credential: { type: "delegated_user" },
      organizationId: "org_123",
      scopes: ["stella:read", "stella:search"],
      userId: "user_123",
    });
  });

  test("preserves the verified OAuth client for later provenance resolution", () => {
    expect(
      extractMcpSession({
        azp: "agent-client-123",
        org_id: "org_123",
        scope: "stella:read",
        sub: "user_123",
      }),
    ).toEqual({
      credential: { clientId: "agent-client-123", type: "oauth_client" },
      organizationId: "org_123",
      scopes: ["stella:read"],
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

  test("preserves agent-run provenance and workspace attenuation", () => {
    expect(
      extractMcpSession({
        org_id: "org_123",
        purpose: "agent-run",
        run_id: "run_123",
        scope: "stella:read",
        sub: "user_123",
        workspace_ids: ["workspace_1"],
      }),
    ).toEqual({
      credential: { runId: "run_123", type: "agent_run" },
      organizationId: "org_123",
      scopes: ["stella:read"],
      userId: "user_123",
      workspaceIds: ["workspace_1"],
    });
  });

  test("rejects agent-run tokens without a run id or workspace attenuation", () => {
    expect(() =>
      extractMcpSession({
        org_id: "org_123",
        purpose: "agent-run",
        scope: "stella:read",
        sub: "user_123",
        workspace_ids: ["workspace_1"],
      }),
    ).toThrow("Agent-run token missing run_id claim");

    expect(() =>
      extractMcpSession({
        org_id: "org_123",
        purpose: "agent-run",
        run_id: "run_123",
        scope: "stella:read",
        sub: "user_123",
      }),
    ).toThrow("Agent-run token missing workspace_ids claim");
  });

  test("rejects an unclassified run id", () => {
    expect(() =>
      extractMcpSession({
        org_id: "org_123",
        run_id: "run_123",
        scope: "stella:read",
        sub: "user_123",
      }),
    ).toThrow("Token run_id claim requires agent-run purpose");
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

describe("isMcpSession", () => {
  test("accepts every credential branch and optional workspace attenuation", () => {
    const credentials = [
      { type: "agent_run", runId: "run_1" },
      { type: "oauth_client", clientId: "client_1" },
      {
        type: "machine_api_key",
        id: "key_1",
        name: "Automation",
        permissions: { workspace: ["read"] },
      },
      { type: "delegated_user" },
    ];

    for (const credential of credentials) {
      expect(
        isMcpSession({
          credential,
          organizationId: "org_1",
          scopes: ["read"],
          userId: "user_1",
          workspaceIds: ["workspace_1"],
        }),
      ).toBe(true);
    }

    expect(
      isMcpSession({
        organizationId: "org_1",
        scopes: ["read"],
        userId: "user_1",
      }),
    ).toBe(true);
  });

  test("rejects malformed nested session fields", () => {
    const invalidSessions = [
      { organizationId: "org_1", scopes: [42], userId: "user_1" },
      { organizationId: "org_1", scopes: [""], userId: "user_1" },
      {
        credential: { type: "agent_run", runId: "" },
        organizationId: "org_1",
        scopes: ["read"],
        userId: "user_1",
      },
      {
        credential: { type: "unexpected" },
        organizationId: "org_1",
        scopes: ["read"],
        userId: "user_1",
      },
      {
        organizationId: "org_1",
        scopes: ["read"],
        userId: "user_1",
        workspaceIds: [null],
      },
      {
        credential: undefined,
        organizationId: "org_1",
        scopes: ["read"],
        userId: "user_1",
      },
      {
        organizationId: "org_1",
        scopes: ["read"],
        userId: "user_1",
        workspaceIds: undefined,
      },
      // A key credential carries the permission set authorization holds it to,
      // so one recovered without a usable set is not a session.
      {
        credential: {
          type: "machine_api_key",
          id: "key_1",
          name: "Automation",
        },
        organizationId: "org_1",
        scopes: ["read"],
        userId: "user_1",
      },
      {
        credential: {
          type: "machine_api_key",
          id: "key_1",
          name: "Automation",
          permissions: { notARealResource: ["read"] },
        },
        organizationId: "org_1",
        scopes: ["read"],
        userId: "user_1",
      },
    ];

    for (const session of invalidSessions) {
      expect(isMcpSession(session)).toBe(false);
    }
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
    // `verifyBearerToken` re-throws a JWKS fetch/network failure as a plain
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

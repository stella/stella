import { describe, expect, test } from "bun:test";

import {
  buildMcpClientMetadataDocument,
  clientRegistrationMode,
  getMcpClientMetadataDocumentUrl,
  getMcpOAuthRedirectUri,
  tokenExpiresAt,
} from "@/api/handlers/mcp-connectors/oauth";
import type {
  AuthorizationServerMetadata,
  TokenResponse,
} from "@/api/handlers/mcp-connectors/oauth";
import { redactMcpOAuthRegistrationResponse } from "@/api/handlers/mcp-connectors/oauth-registration-response";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const authorizationServer = (
  overrides: Partial<AuthorizationServerMetadata>,
): AuthorizationServerMetadata => ({
  issuer: "https://as.example.com",
  authorization_endpoint: "https://as.example.com/authorize",
  token_endpoint: "https://as.example.com/token",
  ...overrides,
});

describe("clientRegistrationMode", () => {
  test("prefers CIMD when the server advertises support", () => {
    expect(
      clientRegistrationMode(
        authorizationServer({
          client_id_metadata_document_supported: true,
          registration_endpoint: "https://as.example.com/register",
        }),
      ),
    ).toBe("cimd");
  });

  test("falls back to dynamic registration when only DCR is offered", () => {
    expect(
      clientRegistrationMode(
        authorizationServer({
          registration_endpoint: "https://as.example.com/register",
        }),
      ),
    ).toBe("dcr");
  });

  test("reports unsupported when neither mechanism is offered", () => {
    expect(clientRegistrationMode(authorizationServer({}))).toBe("unsupported");
    expect(
      clientRegistrationMode(
        authorizationServer({
          client_id_metadata_document_supported: false,
        }),
      ),
    ).toBe("unsupported");
  });
});

describe("buildMcpClientMetadataDocument", () => {
  test("client_id equals the URL the document is served from", () => {
    const document = buildMcpClientMetadataDocument();

    expect(document.client_id).toBe(getMcpClientMetadataDocumentUrl());
    expect(new URL(document.client_id).pathname).toBe(
      "/v1/mcp/oauth/client-metadata.json",
    );
  });

  test("describes a public client without any shared secret", () => {
    const document = buildMcpClientMetadataDocument();

    expect(document.token_endpoint_auth_method).toBe("none");
    expect(document.redirect_uris).toEqual([getMcpOAuthRedirectUri()]);
    expect(Object.keys(document)).not.toContain("client_secret");
  });
});

describe("redactMcpOAuthRegistrationResponse", () => {
  test("removes client credentials from dynamic registration metadata", () => {
    const redacted = redactMcpOAuthRegistrationResponse({
      client_id: "client-123",
      client_secret: "secret",
      nested: {
        registration_access_token: "token",
        safe_value: "kept",
      },
      token_endpoint_auth_method: "none",
    });

    expect(redacted).toEqual({
      client_id: "client-123",
      client_secret: "[redacted]",
      nested: {
        registration_access_token: "[redacted]",
        safe_value: "kept",
      },
      token_endpoint_auth_method: "none",
    });
  });

  test("redacts secrets inside an array of objects, preserving siblings", () => {
    const redacted = redactMcpOAuthRegistrationResponse({
      keys: [{ client_secret: "x", kid: "ok" }],
    });
    expect(redacted).toEqual({
      keys: [{ client_secret: "[redacted]", kid: "ok" }],
    });
  });

  test("redacts suffix-matched keys case-insensitively", () => {
    const redacted = redactMcpOAuthRegistrationResponse({
      app_secret: "x",
      DB_PASSWORD: "y",
      jwt_assertion: "z",
      keep_me: "ok",
    });
    expect(redacted).toEqual({
      app_secret: "[redacted]",
      DB_PASSWORD: "[redacted]",
      jwt_assertion: "[redacted]",
      keep_me: "ok",
    });
  });
});

describe("tokenExpiresAt", () => {
  const token = (expires_in: number | undefined): TokenResponse =>
    asTestRaw<TokenResponse>({
      access_token: "a",
      token_type: "Bearer",
      expires_in,
    });

  test("returns null when expires_in is absent or non-positive", () => {
    expect(tokenExpiresAt(token(undefined))).toBeNull();
    expect(tokenExpiresAt(token(0))).toBeNull();
    expect(tokenExpiresAt(token(-5))).toBeNull();
  });

  test("returns a future instant ~expires_in seconds out", () => {
    const before = Date.now();
    const result = tokenExpiresAt(token(3600));
    const after = Date.now();
    expect(result).not.toBeNull();
    const ms = result?.getTime() ?? 0;
    expect(ms).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(ms).toBeLessThanOrEqual(after + 3_600_000);
  });
});

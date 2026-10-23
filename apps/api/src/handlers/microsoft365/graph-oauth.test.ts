import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { sha256Base64Url as legacyBase64Url } from "@stll/sha256/node";

import { delegatedScopes } from "@/api/lib/auth/microsoft365/capabilities";
import {
  buildAuthorizeUrl,
  createPkce,
  exchangeMicrosoft365AuthorizationCode,
} from "@/api/lib/auth/microsoft365/graph-oauth";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import {
  SafeOutboundFetchError,
  type safeOutboundFetchBytes,
} from "@/api/lib/safe-outbound-fetch";

describe("buildAuthorizeUrl", () => {
  test("carries the OAuth and PKCE parameters", () => {
    const url = new URL(
      buildAuthorizeUrl({
        scope: delegatedScopes({
          requested: ["files.read"],
          grantedScope: null,
          policy: {
            microsoft365ConnectionEnabled: true,
            microsoft365FilesReadEnabled: true,
            microsoft365CalendarReadEnabled: false,
          },
        }),
        clientId: "client-123",
        tenantId: "tenant-abc",
        codeChallenge: "challenge",
        redirectUri: "https://api.example.com/v1/microsoft365/oauth/callback",
        state: "state-xyz",
      }),
    );

    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.pathname).toBe("/tenant-abc/oauth2/v2.0/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("scope")).toContain(
      "https://graph.microsoft.com/Files.Read.All",
    );
    expect(url.searchParams.get("scope")).toContain(
      "https://graph.microsoft.com/Sites.Read.All",
    );
  });
});

test("Microsoft 365 PKCE preserves the legacy unpadded base64url digest", () => {
  const { codeVerifier, codeChallenge } = createPkce();
  expect(codeChallenge).toBe(legacyBase64Url(codeVerifier));
});

test("token exchange parses successful responses and reports HTTP failures", async () => {
  const permit = grantThirdPartyOutboundPermit();
  let call = 0;
  const fetchBytes: typeof safeOutboundFetchBytes = async ({
    maxBytes,
    timeout,
  }) => {
    expect(maxBytes).toBe(64 * 1024);
    expect(timeout).toEqual({ type: "headers", ms: 10_000 });
    call += 1;
    if (call === 2) {
      return Result.ok({
        body: new ArrayBuffer(0),
        headers: new Headers(),
        ok: false,
        status: 503,
      });
    }
    return Result.ok({
      body: new TextEncoder().encode(
        JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "User.Read",
        }),
      ).buffer,
      headers: new Headers(),
      ok: true,
      status: 200,
    });
  };
  const options = {
    clientId: "client-id",
    clientSecret: "client-secret",
    code: "authorization-code",
    codeVerifier: "verifier",
    redirectUri: "https://api.example.test/callback",
    tenantId: "tenant-id",
    permit,
    fetchBytes,
  };
  const token = await exchangeMicrosoft365AuthorizationCode(options);
  expect(Result.isOk(token) && token.value).toMatchObject({
    access_token: "access-token",
    refresh_token: "refresh-token",
    token_type: "Bearer",
    scope: "User.Read",
  });
  const unavailable = await exchangeMicrosoft365AuthorizationCode(options);
  expect(Result.isError(unavailable)).toBe(true);
  if (Result.isError(unavailable)) {
    expect(unavailable.error.message).toBe(
      "Microsoft token endpoint returned HTTP 503",
    );
  }
});

test("token exchange delegates its byte ceiling to safe outbound transport", async () => {
  const fetchBytes: typeof safeOutboundFetchBytes = async ({ maxBytes }) => {
    expect(maxBytes).toBe(64 * 1024);
    return Result.err(
      new SafeOutboundFetchError({
        message: "Response body exceeded size limit",
      }),
    );
  };
  const result = await exchangeMicrosoft365AuthorizationCode({
    clientId: "id",
    clientSecret: "secret",
    code: "code",
    codeVerifier: "verifier",
    redirectUri: "https://api.example.test/callback",
    tenantId: "tenant",
    permit: grantThirdPartyOutboundPermit(),
    fetchBytes,
  });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.message).toBe(
      "Failed to reach the Microsoft token endpoint",
    );
  }
});

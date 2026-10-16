import { describe, expect, test } from "bun:test";

import { sha256Base64Url as legacyBase64Url } from "@stll/sha256/node";

import {
  buildAuthorizeUrl,
  createPkce,
} from "@/api/handlers/microsoft365/graph-oauth";

import { delegatedScopes } from "./capabilities";

describe("buildAuthorizeUrl", () => {
  test("carries the OAuth and PKCE parameters", () => {
    const url = new URL(
      buildAuthorizeUrl({
        scope: delegatedScopes(["files.read"], null),
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
  });
});

test("Microsoft 365 PKCE preserves the legacy unpadded base64url digest", () => {
  const { codeVerifier, codeChallenge } = createPkce();
  expect(codeChallenge).toBe(legacyBase64Url(codeVerifier));
});

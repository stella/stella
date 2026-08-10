import { describe, expect, test } from "bun:test";

import { buildAuthorizeUrl } from "@/api/handlers/sharepoint/graph-oauth";

describe("buildAuthorizeUrl", () => {
  test("carries the OAuth and PKCE parameters", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "client-123",
        tenantId: "tenant-abc",
        codeChallenge: "challenge",
        redirectUri: "https://api.example.com/v1/sharepoint/oauth/callback",
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

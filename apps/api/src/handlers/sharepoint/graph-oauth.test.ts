import { describe, expect, test } from "bun:test";

import {
  buildAuthorizeUrl,
  isReadOnlyGraphScope,
  SHAREPOINT_DELEGATED_SCOPES,
} from "@/api/handlers/sharepoint/graph-oauth";

describe("SharePoint delegated scopes", () => {
  test("every requested scope is read-only (no write scope is ever requested)", () => {
    for (const scope of SHAREPOINT_DELEGATED_SCOPES) {
      expect(scope.toLowerCase()).not.toContain("write");
      expect(isReadOnlyGraphScope(scope)).toBe(true);
    }
  });

  test("requests exactly the intended read-only + offline set", () => {
    expect([...SHAREPOINT_DELEGATED_SCOPES].sort()).toEqual(
      [
        "offline_access",
        "https://graph.microsoft.com/User.Read",
        "https://graph.microsoft.com/Files.Read.All",
        "https://graph.microsoft.com/Sites.Read.All",
      ].sort(),
    );
  });

  test("isReadOnlyGraphScope flags any ReadWrite variant", () => {
    expect(
      isReadOnlyGraphScope("https://graph.microsoft.com/Files.ReadWrite.All"),
    ).toBe(false);
    expect(
      isReadOnlyGraphScope("https://graph.microsoft.com/Sites.ReadWrite.All"),
    ).toBe(false);
  });
});

describe("buildAuthorizeUrl", () => {
  test("carries only the read-only scopes and PKCE parameters", () => {
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

    const requestedScopes = (url.searchParams.get("scope") ?? "").split(" ");
    for (const scope of requestedScopes) {
      expect(scope.toLowerCase()).not.toContain("write");
    }
    expect(requestedScopes).toEqual([...SHAREPOINT_DELEGATED_SCOPES]);
  });
});

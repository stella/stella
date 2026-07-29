import { describe, expect, test } from "bun:test";

import {
  getExpandedOauthAuthorizationUrl,
  getOauthClientDisplayName,
  getOauthHashFragment,
  getOauthRedirectUrl,
  getSignedOauthQueryFromHash,
  hasSignedOauthQuery,
} from "@/lib/oauth-provider";

describe("getExpandedOauthAuthorizationUrl", () => {
  test("restarts a signed authorization request with expanded scopes", () => {
    const result = getExpandedOauthAuthorizationUrl({
      apiBaseUrl: "https://api.example.com",
      oauthQuery:
        "client_id=client-123&redirect_uri=https%3A%2F%2Fchat.example%2Fcallback&response_type=code&scope=openid+stella%3Aread&state=state-123&code_challenge=challenge&code_challenge_method=S256&resource=https%3A%2F%2Fapi.example.com%2Fmcp&exp=123&ba_iat=456&ba_param=client_id&ba_param=scope&sig=abc123",
      scopes: ["stella:read", "stella:matters_write"],
    });

    expect(result).not.toBeNull();
    const url = new URL(result ?? "https://invalid.example");
    expect(url.origin + url.pathname).toBe(
      "https://api.example.com/api/auth/oauth2/authorize",
    );
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "stella:read",
      "stella:matters_write",
    ]);
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("resource")).toBe(
      "https://api.example.com/mcp",
    );
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.has("sig")).toBe(false);
    expect(url.searchParams.has("exp")).toBe(false);
    expect(url.searchParams.has("ba_iat")).toBe(false);
    expect(url.searchParams.has("ba_param")).toBe(false);
  });

  test("preserves stronger login and account-selection prompts", () => {
    const baseQuery =
      "client_id=client-123&redirect_uri=https%3A%2F%2Fchat.example%2Fcallback&response_type=code&sig=abc123";

    const login = getExpandedOauthAuthorizationUrl({
      apiBaseUrl: "https://api.example.com",
      oauthQuery: `${baseQuery}&prompt=login`,
      scopes: ["stella:read"],
    });
    const select = getExpandedOauthAuthorizationUrl({
      apiBaseUrl: "https://api.example.com",
      oauthQuery: `${baseQuery}&prompt=select_account`,
      scopes: ["stella:read"],
    });

    expect(
      new URL(login ?? "https://invalid.example").searchParams.get("prompt"),
    ).toBe("login consent");
    expect(
      new URL(select ?? "https://invalid.example").searchParams.get("prompt"),
    ).toBe("select_account consent");
  });

  test("rejects unsigned or incomplete continuation queries", () => {
    expect(
      getExpandedOauthAuthorizationUrl({
        apiBaseUrl: "https://api.example.com",
        oauthQuery:
          "client_id=client-123&redirect_uri=https%3A%2F%2Fchat.example%2Fcallback&response_type=code",
        scopes: ["stella:read"],
      }),
    ).toBeNull();
    expect(
      getExpandedOauthAuthorizationUrl({
        apiBaseUrl: "https://api.example.com",
        oauthQuery: "client_id=client-123&sig=abc123",
        scopes: ["stella:read"],
      }),
    ).toBeNull();
  });
});

describe("hasSignedOauthQuery", () => {
  test("detects Better Auth signed OAuth params", () => {
    expect(
      hasSignedOauthQuery("?client_id=client-123&scope=openid&sig=abc123"),
    ).toBe(true);
  });

  test("ignores ordinary query strings", () => {
    expect(hasSignedOauthQuery("?redirectTo=%2Fdashboard")).toBe(false);
  });
});

describe("getSignedOauthQueryFromHash", () => {
  test("preserves repeated Better Auth signed query params from the hash bridge", () => {
    const query =
      "client_id=client-123&ba_param=client_id&ba_param=scope&scope=openid&sig=abc123";

    expect(getSignedOauthQueryFromHash(getOauthHashFragment(query))).toBe(
      query,
    );
  });

  test("ignores hash fragments without signed OAuth params", () => {
    expect(getSignedOauthQueryFromHash("#oauth_query=redirectTo%3D%252F")).toBe(
      null,
    );
  });
});

describe("getOauthClientDisplayName", () => {
  test("prefers OAuth registration metadata names", () => {
    expect(
      getOauthClientDisplayName({
        client_name: "Inspector",
        name: "Fallback",
      }),
    ).toBe("Inspector");
  });

  test("falls back to generic name fields", () => {
    expect(getOauthClientDisplayName({ name: "CLI" })).toBe("CLI");
  });
});

describe("getOauthRedirectUrl", () => {
  test("reads Better Auth client action redirects", () => {
    expect(
      getOauthRedirectUrl({ url: "https://client.example/callback" }),
    ).toBe("https://client.example/callback");
  });

  test("reads raw OAuth endpoint redirect URIs", () => {
    expect(
      getOauthRedirectUrl({
        redirect_uri: "https://client.example/callback?code=123",
      }),
    ).toBe("https://client.example/callback?code=123");
  });
});

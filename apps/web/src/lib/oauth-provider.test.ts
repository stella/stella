import { describe, expect, test } from "bun:test";

import {
  getOauthClientDisplayName,
  getOauthHashFragment,
  getOauthRedirectUrl,
  getSignedOauthQueryFromHash,
  hasSignedOauthQuery,
} from "@/lib/oauth-provider";

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

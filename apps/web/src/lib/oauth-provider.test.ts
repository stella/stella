import { describe, expect, test } from "bun:test";

import {
  getOauthAccountSwitchHref,
  getOauthClientDisplayName,
  getOauthHashFragment,
  getOauthRedirectUrl,
  getSignedOauthQuery,
  getSignedOauthQueryFromHash,
  hasOauthPrompt,
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

describe("getSignedOauthQuery", () => {
  const query = "client_id=client-123&prompt=login&sig=abc123";

  test("reads the hash bridge first", () => {
    expect(
      getSignedOauthQuery({
        hash: `#${getOauthHashFragment(query)}`,
        searchStr: "?client_id=other&sig=other",
      }),
    ).toBe(query);
  });

  test("falls back to a signed page query without its question mark", () => {
    expect(getSignedOauthQuery({ hash: "", searchStr: `?${query}` })).toBe(
      query,
    );
  });

  test("ignores unsigned queries", () => {
    expect(
      getSignedOauthQuery({ hash: "", searchStr: "?redirectTo=%2F" }),
    ).toBe(null);
  });
});

describe("hasOauthPrompt", () => {
  test("finds each prompt value of a space-separated list", () => {
    const query = "client_id=client-123&prompt=consent+login&sig=abc123";
    expect(hasOauthPrompt(query, "login")).toBe(true);
    expect(hasOauthPrompt(query, "select_account")).toBe(false);
  });

  test("matches whole values only", () => {
    expect(hasOauthPrompt("prompt=logins&sig=abc123", "login")).toBe(false);
    expect(
      hasOauthPrompt("prompt=select_account&sig=abc123", "select_account"),
    ).toBe(true);
  });

  test("is false without a signed request or prompt", () => {
    expect(hasOauthPrompt(null, "login")).toBe(false);
    expect(hasOauthPrompt("client_id=client-123&sig=abc123", "login")).toBe(
      false,
    );
  });
});

describe("getOauthAccountSwitchHref", () => {
  test("returns to sign-in with the exact signed OAuth request from the hash bridge", () => {
    const query =
      "client_id=client-123&ba_param=client_id&ba_param=scope&scope=openid%20stella%3Aread&sig=abc%2B123";
    const href = getOauthAccountSwitchHref({
      hash: `#${getOauthHashFragment(query)}`,
      pathname: "/auth/organization",
      search: "",
    });

    const target = new URL(href, "https://my.example");
    expect(target.pathname).toBe("/auth");
    expect(target.search).toBe("");
    expect(getSignedOauthQueryFromHash(target.hash)).toBe(query);
  });

  test("returns to the same page after sign-in when no signed request is bridged", () => {
    const href = getOauthAccountSwitchHref({
      hash: "#oauth_query=redirectTo%3D%252F",
      pathname: "/auth/organization",
      search: "?client_id=client-123&sig=abc123",
    });

    const target = new URL(href, "https://my.example");
    expect(target.pathname).toBe("/auth");
    expect(target.hash).toBe("");
    expect(target.searchParams.get("redirectTo")).toBe(
      "/auth/organization?client_id=client-123&sig=abc123",
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

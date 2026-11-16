import { describe, expect, test } from "bun:test";

import { shouldRejectBrowserMutation } from "@/api/lib/browser-origin-guard";

const allowedOrigins = ["https://my.example.com", /^chrome-extension:\/\//u];
const providerFormPost = {
  origin: "https://idp.example",
  pathname: "/api/auth/callback/idp",
};
const guard = (
  request: Pick<
    Parameters<typeof shouldRejectBrowserMutation>[0],
    "method" | "origin" | "secFetchSite"
  > & { pathname?: string },
) =>
  shouldRejectBrowserMutation({
    allowedOrigins,
    crossSiteFormPosts: [providerFormPost],
    pathname: "/workspaces",
    ...request,
  });

describe("browser mutation origin guard", () => {
  test("allows safe methods and trusted browser origins", () => {
    expect(
      guard({
        method: "GET",
        origin: "https://attacker.example",
        secFetchSite: "cross-site",
      }),
    ).toBe(false);
    expect(
      guard({
        method: "POST",
        origin: "https://my.example.com",
        secFetchSite: "same-origin",
      }),
    ).toBe(false);
  });

  test("rejects untrusted browser mutations, including sibling sites", () => {
    expect(
      guard({
        method: "POST",
        origin: "https://attacker.example",
        secFetchSite: "cross-site",
      }),
    ).toBe(true);
    expect(
      guard({
        method: "DELETE",
        origin: null,
        secFetchSite: "same-site",
      }),
    ).toBe(true);
  });

  test("keeps non-browser clients and configured extensions working", () => {
    expect(
      guard({
        method: "PATCH",
        origin: null,
        secFetchSite: null,
      }),
    ).toBe(false);
    expect(
      guard({
        method: "PUT",
        origin: "chrome-extension://abcdefghijklmnop",
        secFetchSite: "cross-site",
      }),
    ).toBe(false);
  });

  test("admits a provider's form post only from its origin, to its path, as a POST", () => {
    expect(
      guard({
        method: "POST",
        origin: providerFormPost.origin,
        pathname: providerFormPost.pathname,
        secFetchSite: "cross-site",
      }),
    ).toBe(false);
    // Any other combination stays refused.
    for (const request of [
      {
        origin: "https://attacker.example",
        pathname: providerFormPost.pathname,
      },
      { origin: providerFormPost.origin, pathname: "/workspaces" },
      { origin: providerFormPost.origin, pathname: "/api/auth/callback/other" },
      {
        origin: providerFormPost.origin,
        pathname: `${providerFormPost.pathname}/`,
      },
    ]) {
      expect(
        guard({ method: "POST", secFetchSite: "cross-site", ...request }),
      ).toBe(true);
    }
    expect(
      guard({
        method: "DELETE",
        origin: providerFormPost.origin,
        pathname: providerFormPost.pathname,
        secFetchSite: "cross-site",
      }),
    ).toBe(true);
  });
});

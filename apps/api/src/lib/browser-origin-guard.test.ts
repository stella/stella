import { describe, expect, test } from "bun:test";

import { shouldRejectBrowserMutation } from "@/api/lib/browser-origin-guard";

const allowedOrigins = ["https://my.example.com", /^chrome-extension:\/\//u];

describe("browser mutation origin guard", () => {
  test("allows safe methods and trusted browser origins", () => {
    expect(
      shouldRejectBrowserMutation({
        allowedOrigins,
        method: "GET",
        origin: "https://attacker.example",
        secFetchSite: "cross-site",
      }),
    ).toBe(false);
    expect(
      shouldRejectBrowserMutation({
        allowedOrigins,
        method: "POST",
        origin: "https://my.example.com",
        secFetchSite: "same-origin",
      }),
    ).toBe(false);
  });

  test("rejects untrusted browser mutations, including sibling sites", () => {
    expect(
      shouldRejectBrowserMutation({
        allowedOrigins,
        method: "POST",
        origin: "https://attacker.example",
        secFetchSite: "cross-site",
      }),
    ).toBe(true);
    expect(
      shouldRejectBrowserMutation({
        allowedOrigins,
        method: "DELETE",
        origin: null,
        secFetchSite: "same-site",
      }),
    ).toBe(true);
  });

  test("keeps non-browser clients and configured extensions working", () => {
    expect(
      shouldRejectBrowserMutation({
        allowedOrigins,
        method: "PATCH",
        origin: null,
        secFetchSite: null,
      }),
    ).toBe(false);
    expect(
      shouldRejectBrowserMutation({
        allowedOrigins,
        method: "PUT",
        origin: "chrome-extension://abcdefghijklmnop",
        secFetchSite: "cross-site",
      }),
    ).toBe(false);
  });
});

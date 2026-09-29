import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  normalizeRedirectTo,
  redirectToSchema,
  returnPathOf,
  toAppRedirectTo,
} from "@/lib/redirect";

const sanitize = (input: string | undefined) =>
  v.parse(redirectToSchema, input);

const scriptSchemeUrl = ["java", "script:alert(1)"].join("");

describe("redirectToSchema open-redirect guard", () => {
  test("keeps legitimate same-origin relative paths", () => {
    for (const ok of [
      "/",
      "/dashboard",
      "/workspaces/abc/all/document?entity=123&field=456",
      "/auth/accept-invitation/xyz",
      "/path?q=1&r=2",
      "/path#frag",
    ]) {
      expect(sanitize(ok)).toBe(ok);
    }
  });

  test("defaults to '/' when the param is absent", () => {
    expect(sanitize(undefined)).toBe("/");
  });

  test("collapses protocol-relative '//host' escapes to '/'", () => {
    expect(sanitize("//evil.com")).toBe("/");
    expect(sanitize("//evil.com/path")).toBe("/");
  });

  test("collapses backslash protocol-relative escapes to '/' (the regression)", () => {
    // Browsers normalize "/\\host", "\\/host", and "/\\/host" to a
    // protocol-relative external origin. The "//"-only guard let these
    // through unchanged; the tightened guard must neutralize them.
    for (const evil of ["/\\evil.com", "/\\/evil.com", "/\\\\evil.com"]) {
      expect(sanitize(evil)).toBe("/");
    }
  });

  test("rejects absolute and scheme URLs", () => {
    for (const evil of [
      "https://evil.com",
      "http://evil.com",
      scriptSchemeUrl,
      "evil.com",
      "ftp://evil.com",
    ]) {
      expect(sanitize(evil)).toBe("/");
    }
  });

  test("INVARIANT: any accepted value is a relative path whose 2nd char is not / or \\", () => {
    const corpus = [
      "/",
      "/a",
      "//x",
      "/\\x",
      "\\/x",
      "/\\/x",
      "https://x",
      "/ok/path",
      "//",
      "/\t/x",
      "",
    ];
    for (const input of corpus) {
      const out = sanitize(input);
      // Whatever survives must start with a single slash and not begin a
      // protocol-relative escape.
      expect(out.startsWith("/")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
      expect(out.startsWith("/\\")).toBe(false);
    }
  });
});

const HOSTILE_TARGETS = [
  "//evil.com",
  "/\\evil.com",
  "\\/evil.com",
  "/\t/evil.com",
  "/\n/evil.com",
  "https://evil.com",
  scriptSchemeUrl,
  "evil.com",
  "",
];

describe("normalizeRedirectTo", () => {
  test("keeps a same-origin path with its query and fragment", () => {
    expect(normalizeRedirectTo("/knowledge/templates?intent=use#top")).toBe(
      "/knowledge/templates?intent=use#top",
    );
  });

  test("sends every hostile target to '/'", () => {
    for (const evil of HOSTILE_TARGETS) {
      expect(normalizeRedirectTo(evil)).toBe("/");
    }
  });

  test("returns the path the browser resolves", () => {
    expect(normalizeRedirectTo("/x/../chat?a=1")).toBe("/chat?a=1");
    expect(normalizeRedirectTo("/x/%2e%2e/chat")).toBe("/chat");
    expect(normalizeRedirectTo("/x\\..\\chat")).toBe("/chat");
  });

  test("a target that resolves to another origin falls back to '/'", () => {
    for (const evil of ["/x/..//evil.com", "/x/%2e%2e//evil.com"]) {
      expect(normalizeRedirectTo(evil)).toBe("/");
    }
  });
});

describe("returnPathOf", () => {
  test("keeps the path and the query of the page asked for", () => {
    expect(
      returnPathOf({
        pathname: "/workspaces/abc/all",
        searchStr: "?entity=1&view=table",
      }),
    ).toBe("/workspaces/abc/all?entity=1&view=table");
  });

  test("a page without a query returns its path", () => {
    expect(returnPathOf({ pathname: "/chat", searchStr: "" })).toBe("/chat");
  });

  test("a hostile location falls back to '/'", () => {
    expect(returnPathOf({ pathname: "//evil.com", searchStr: "" })).toBe("/");
    expect(returnPathOf({ pathname: "/\\evil.com", searchStr: "?a=1" })).toBe(
      "/",
    );
  });
});

describe("toAppRedirectTo", () => {
  test("keeps an app page with its query", () => {
    expect(toAppRedirectTo("/knowledge/templates?intent=use&slug=nda")).toBe(
      "/knowledge/templates?intent=use&slug=nda",
    );
    // Only the auth and onboarding segments themselves are refused.
    expect(toAppRedirectTo("/authors")).toBe("/authors");
    expect(toAppRedirectTo("/onboarding-guide")).toBe("/onboarding-guide");
  });

  test("an absent or default target leaves the landing page to the caller", () => {
    expect(toAppRedirectTo(undefined)).toBeUndefined();
    expect(toAppRedirectTo("/")).toBeUndefined();
  });

  test("never ends the trip on a sign-in or onboarding page", () => {
    for (const loop of [
      "/auth",
      "/auth?redirectTo=/chat",
      "/auth/organization",
      "/auth/otp?email=a@b.c",
      "/auth/accept-invitation/xyz",
      "/onboarding",
      "/onboarding?preview=true",
      "/onboarding#step",
    ]) {
      expect(toAppRedirectTo(loop)).toBeUndefined();
    }
  });

  // Route matching resolves dot segments, reads "\" as "/", decodes the path
  // and ignores case, so each of these opens a sign-in or onboarding page.
  test("never ends the trip on a path that resolves to sign-in or onboarding", () => {
    for (const loop of [
      "/x/../auth",
      "/x/%2e%2e/onboarding",
      "/x/%2E%2E/auth/otp",
      "/x\\..\\auth",
      "/AUTH",
      "/Onboarding?preview=true",
      "/%61uth",
      "/auth%2Forganization",
    ]) {
      expect(toAppRedirectTo(loop)).toBeUndefined();
    }
  });

  test("returns the resolved path it lets through", () => {
    expect(toAppRedirectTo("/x/../knowledge?intent=use")).toBe(
      "/knowledge?intent=use",
    );
  });

  test("a malformed escape is no destination", () => {
    expect(toAppRedirectTo("/%E0%A4%A")).toBeUndefined();
  });

  test("refuses every hostile target", () => {
    for (const evil of HOSTILE_TARGETS) {
      expect(toAppRedirectTo(evil)).toBeUndefined();
    }
  });
});

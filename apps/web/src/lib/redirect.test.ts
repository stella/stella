import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { redirectToSchema } from "@/lib/redirect";

const sanitize = (input: string | undefined) =>
  v.parse(redirectToSchema, input);

const scriptSchemeUrl = ["java", "script:alert(1)"].join("");

describe("redirectToSchema open-redirect guard", () => {
  test("keeps legitimate same-origin relative paths", () => {
    for (const ok of [
      "/",
      "/dashboard",
      "/workspaces/abc/entities/123",
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

import { describe, expect, test } from "bun:test";

import { sanitizeHref } from "@/lib/sanitize-href";

describe("sanitizeHref", () => {
  test("allows safe app, web, fragment, and mail links", () => {
    expect(sanitizeHref("/docs/getting-started/introduction")).toBe(
      "/docs/getting-started/introduction",
    );
    expect(sanitizeHref("#section")).toBe("#section");
    expect(sanitizeHref("https://stll.app/docs")).toBe("https://stll.app/docs");
    expect(sanitizeHref("mailto:hello@stll.app")).toBe("mailto:hello@stll.app");
  });

  test("rejects a scheme-relative URL wearing a path's leading slash", () => {
    // `//host/p` and `/\host` both resolve against the page's scheme and
    // leave the origin, so neither is the in-app path its slash suggests.
    expect(sanitizeHref("//example.test/docs")).toBeUndefined();
    expect(sanitizeHref("/\\example.test/docs")).toBeUndefined();
    expect(sanitizeHref("/docs")).toBe("/docs");
  });

  test("rejects executable protocols", () => {
    const scriptHref = ["java", "script:alert(1)"].join("");

    expect(sanitizeHref(scriptHref)).toBeUndefined();
    expect(
      sanitizeHref("data:text/html,<script>alert(1)</script>"),
    ).toBeUndefined();
    expect(sanitizeHref("vbscript:msgbox(1)")).toBeUndefined();
  });
});

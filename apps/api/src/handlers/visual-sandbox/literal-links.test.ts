import { describe, expect, test } from "bun:test";

import { collectLiteralVisualLinks } from "./literal-links";
import { sanitizeVisualHtml } from "./sanitize";

describe("stored visual link references", () => {
  test("preserves complete literal links in attributes, text and scripts", () => {
    const sanitized = sanitizeVisualHtml(
      '<a href="https://example.test/report?year=2026&amp;page=2">Report</a>' +
        "<p>https://example.test/text</p>" +
        '<script>const link = "https://example.test/script?section=1";</script>',
    );
    expect(sanitized.isOk()).toBe(true);
    if (sanitized.isErr()) {
      return;
    }
    const links = collectLiteralVisualLinks(sanitized.value);
    expect(links).toContain("https://example.test/report?year=2026&page=2");
    expect(links).toContain("https://example.test/text");
    expect(links).toContain("https://example.test/script?section=1");
    expect(new Set(links).size).toBe(links.length);
  });

  test("never evaluates scripts or expands literal URLs with computed values", () => {
    const sanitized = sanitizeVisualHtml(
      '<script>throw new Error("must not execute"); ' +
        'const base = "https://example.test/view"; const url = base + "?value=" + data.value;</script>',
    );
    expect(sanitized.isOk()).toBe(true);
    if (sanitized.isErr()) {
      return;
    }
    const links = collectLiteralVisualLinks(sanitized.value);
    expect(links).toEqual(["https://example.test/view"]);
    for (const suffix of ["?value=1", "?value=two", "/other", "#section"]) {
      expect(links).not.toContain(`https://example.test/view${suffix}`);
    }
  });

  test("retains only bounded HTTP links without embedded credentials", () => {
    const sanitized = sanitizeVisualHtml(
      '<script>const links = ["https://user:password@example.test/", ' +
        '"javascript:alert(1)", "https://example.test/", ' +
        `"https://example.test/${"x".repeat(4096)}"];</script>`,
    );
    expect(sanitized.isOk()).toBe(true);
    if (sanitized.isErr()) {
      return;
    }
    expect(collectLiteralVisualLinks(sanitized.value)).toEqual([
      "https://example.test/",
    ]);
  });
});

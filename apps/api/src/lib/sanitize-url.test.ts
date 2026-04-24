import { describe, expect, test } from "bun:test";

import { SAFE_HREF_EMPTY, sanitizeUrl } from "@/api/lib/sanitize-url";

describe("sanitizeUrl", () => {
  test("accepts http URLs", () => {
    const result: string | undefined = sanitizeUrl("http://example.com");
    expect(result).toBe("http://example.com");
  });

  test("accepts https URLs", () => {
    const result: string | undefined = sanitizeUrl(
      "https://example.com/path?q=1",
    );
    expect(result).toBe("https://example.com/path?q=1");
  });

  test("rejects javascript: protocol", () => {
    // eslint-disable-next-line no-script-url -- testing rejection of unsafe protocol
    expect(sanitizeUrl("javascript:alert(1)")).toBeUndefined();
  });

  test("rejects data: protocol", () => {
    expect(sanitizeUrl("data:text/html,<h1>hi</h1>")).toBeUndefined();
  });

  test("rejects ftp: protocol", () => {
    expect(sanitizeUrl("ftp://example.com")).toBeUndefined();
  });

  test("returns undefined for null/undefined/empty", () => {
    expect(sanitizeUrl(null)).toBeUndefined();
    expect(sanitizeUrl(undefined)).toBeUndefined();
    expect(sanitizeUrl("")).toBeUndefined();
    expect(sanitizeUrl("   ")).toBeUndefined();
  });

  test("returns undefined for invalid URLs", () => {
    expect(sanitizeUrl("not-a-url")).toBeUndefined();
  });

  test("trims whitespace", () => {
    const result: string | undefined = sanitizeUrl("  https://example.com  ");
    expect(result).toBe("https://example.com");
  });
});

describe("SAFE_HREF_EMPTY", () => {
  test("is an empty string", () => {
    const result: string = SAFE_HREF_EMPTY;
    expect(result).toBe("");
  });
});

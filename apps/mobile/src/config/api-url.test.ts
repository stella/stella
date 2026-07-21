import { describe, expect, test } from "bun:test";

import { parseMobileApiUrl } from "./api-url";

describe("parseMobileApiUrl", () => {
  test("normalizes an HTTP API base URL", () => {
    expect(parseMobileApiUrl("https://api.example.com")).toBe(
      "https://api.example.com/",
    );
  });

  test("preserves a self-hosted path prefix", () => {
    expect(parseMobileApiUrl("https://example.com/stella/api/")).toBe(
      "https://example.com/stella/api/",
    );
  });

  test.each([
    undefined,
    "not-a-url",
    "ftp://api.example.com",
    "https://user:secret@api.example.com",
    "https://api.example.com?tenant=one",
    "https://api.example.com#config",
  ])("rejects an unsafe API URL: %p", (value) => {
    expect(() => parseMobileApiUrl(value)).toThrow();
  });
});

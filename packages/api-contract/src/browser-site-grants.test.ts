import { describe, expect, test } from "bun:test";

import {
  browserSiteGrantHost,
  browserSiteGrantOrigin,
  isOnGrantedBrowserSite,
} from "./browser-site-grants";

describe("browser site grant origin", () => {
  test("keys a grant on the exact HTTPS origin, whatever the spelling", () => {
    expect(browserSiteGrantOrigin("https://Example.COM/a/b?c=d#e")).toBe(
      "https://example.com",
    );
    expect(browserSiteGrantOrigin("https://example.com:443/")).toBe(
      "https://example.com",
    );
    expect(browserSiteGrantOrigin("https://example.com:8443/")).toBe(
      "https://example.com:8443",
    );
  });

  test("refuses anything that is not a plain HTTPS address", () => {
    for (const url of [
      "http://example.com/",
      "ftp://example.com/",
      "https://user:secret@example.com/",
      "https://user@example.com/",
      "data:text/html,hi",
      "not a url",
      "",
      `https://example.com/${"a".repeat(5000)}`,
    ]) {
      expect(browserSiteGrantOrigin(url)).toBeNull();
    }
  });

  test("a grant covers its own origin only", () => {
    const granted = new Set(["https://example.com"]);
    expect(isOnGrantedBrowserSite("https://example.com/x", granted)).toBe(true);
    for (const url of [
      "https://www.example.com/",
      "https://example.com.attacker.test/",
      "https://attacker.test/https://example.com",
      "http://example.com/",
      "https://example.com:8443/",
    ]) {
      expect(isOnGrantedBrowserSite(url, granted)).toBe(false);
    }
  });

  test("names a grant by its host", () => {
    expect(browserSiteGrantHost("https://example.com")).toBe("example.com");
    expect(browserSiteGrantHost("https://example.com:8443")).toBe(
      "example.com:8443",
    );
  });
});

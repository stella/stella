import { describe, expect, test } from "bun:test";

import {
  isAllowedUserUrl,
  normalizeUserUrl,
  sanitizeExternalUrl,
  sanitizeLinkTarget,
} from "./urlSecurity";

describe("urlSecurity", () => {
  test("blocks executable and unsupported protocols", () => {
    const executableUrl = ["java", "script:alert(1)"].join("");
    expect(sanitizeExternalUrl(executableUrl)).toBeUndefined();
    expect(isAllowedUserUrl(executableUrl)).toBe(false);
    expect(
      sanitizeExternalUrl("data:text/html,<script></script>"),
    ).toBeUndefined();
    expect(sanitizeExternalUrl("ftp://example.com/file")).toBeUndefined();
    expect(normalizeUserUrl("ftp://example.com/file")).toBe("");
    expect(isAllowedUserUrl("ftp://example.com/file")).toBe(false);
  });

  test("allows http, https, mailto, and tel links", () => {
    expect(sanitizeExternalUrl("https://example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(sanitizeExternalUrl("mailto:legal@example.com")).toBe(
      "mailto:legal@example.com",
    );
    expect(sanitizeExternalUrl("tel:+420123456789")).toBe("tel:+420123456789");
  });

  test("rejects empty mail and phone links", () => {
    expect(sanitizeExternalUrl("mailto:")).toBeUndefined();
    expect(sanitizeExternalUrl("tel:")).toBeUndefined();
    expect(isAllowedUserUrl("mailto:")).toBe(false);
    expect(isAllowedUserUrl("tel:")).toBe(false);
  });

  test("normalizes user-entered web URLs to https", () => {
    expect(normalizeUserUrl("example.com/matter")).toBe(
      "https://example.com/matter",
    );
    expect(normalizeUserUrl("https://example.com/matter")).toBe(
      "https://example.com/matter",
    );
    expect(normalizeUserUrl("http://example.com/matter")).toBe(
      "http://example.com/matter",
    );
    expect(normalizeUserUrl("localhost:3000")).toBe("https://localhost:3000/");
    expect(normalizeUserUrl("[::1]:3000")).toBe("https://[::1]:3000/");
    expect(normalizeUserUrl("[2001:db8::1]/doc")).toBe(
      "https://[2001:db8::1]/doc",
    );
    expect(normalizeUserUrl("example.com/resource:latest")).toBe(
      "https://example.com/resource:latest",
    );
    expect(isAllowedUserUrl("example.com")).toBe(true);
    expect(isAllowedUserUrl("https://example.com")).toBe(true);
    expect(isAllowedUserUrl("example.com:abc/path")).toBe(false);
  });

  test("sanitizes link targets", () => {
    expect(sanitizeLinkTarget("_self")).toBe("_self");
    expect(sanitizeLinkTarget("popup")).toBe("_blank");
    expect(sanitizeLinkTarget(undefined)).toBe("_blank");
  });
});

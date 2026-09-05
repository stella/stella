import { describe, expect, test } from "bun:test";

import { isPublicHostname, parseControllableUrl } from "./origin-policy";

describe("controllable origin policy", () => {
  test("accepts named public HTTPS hosts", () => {
    for (const url of [
      "https://example.com/",
      "https://justice.example.org/search?q=1",
      "https://8.8.8.8/",
    ]) {
      expect(parseControllableUrl(url)?.href).toBe(url);
    }
  });

  test("refuses plain HTTP and embedded credentials", () => {
    expect(parseControllableUrl("http://example.com/")).toBeNull();
    expect(parseControllableUrl("https://user:pw@example.com/")).toBeNull();
    expect(parseControllableUrl("javascript:alert(1)")).toBeNull();
    expect(parseControllableUrl("not a url")).toBeNull();
  });

  test("refuses loopback, private, link-local and local hosts", () => {
    for (const hostname of [
      "localhost",
      "app.localhost",
      "intranet",
      "printer.local",
      "metadata.google.internal",
      "127.0.0.1",
      "10.0.0.5",
      "172.16.4.2",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "[::1]",
      "[fe80::1]",
      "[2001:db8::1]",
    ]) {
      expect(isPublicHostname(hostname)).toBe(false);
    }
    expect(parseControllableUrl("https://192.168.1.1/admin")).toBeNull();
    expect(parseControllableUrl("https://[::1]/")).toBeNull();
  });

  test("does not mistake dotted names for IPv4 literals", () => {
    expect(isPublicHostname("10.example.com")).toBe(true);
    expect(isPublicHostname("192.168.1.1.nip.example")).toBe(true);
    expect(isPublicHostname("example.com.")).toBe(true);
  });
});

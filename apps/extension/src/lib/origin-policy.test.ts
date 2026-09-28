import { describe, expect, test } from "bun:test";

import {
  isControllableFrame,
  isPublicHostname,
  NON_PUBLIC_SECURE_URL_PATTERNS,
  parseControllableUrl,
} from "./origin-policy";

const REFUSED_HOSTNAMES = [
  "localhost",
  "app.localhost",
  "intranet",
  "intranet.",
  "printer.local",
  "printer.local.",
  "metadata.google.internal",
  "127.0.0.1",
  "10.0.0.5",
  "172.16.4.2",
  "172.31.255.255",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "100.127.0.1",
  "198.18.0.1",
  "0.0.0.0",
  "224.0.0.1",
  "255.255.255.255",
  "[::1]",
  "[fe80::1]",
  "[2001:db8::1]",
];

const PUBLIC_HOSTNAMES = [
  "example.com",
  "example.com.",
  "justice.example.org",
  "10.example.com",
  "192.168.1.1.nip.example",
  "local.example.com",
  "internal.example.com",
  "localhost.example",
  "8.8.8.8",
  "100.63.0.1",
  "100.128.0.1",
  "172.15.0.1",
  "172.32.0.1",
  "198.20.0.1",
  "223.255.255.255",
];

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
    expect(parseControllableUrl("file:///etc/hosts")).toBeNull();
    expect(parseControllableUrl("data:text/html,hello")).toBeNull();
    expect(parseControllableUrl("not a url")).toBeNull();
  });

  test("refuses loopback, private, link-local and local hosts", () => {
    for (const hostname of REFUSED_HOSTNAMES) {
      expect(isPublicHostname(hostname)).toBe(false);
    }
    expect(parseControllableUrl("https://192.168.1.1/admin")).toBeNull();
    expect(parseControllableUrl("https://[::1]/")).toBeNull();
  });

  test("does not mistake dotted names for IPv4 literals", () => {
    for (const hostname of PUBLIC_HOSTNAMES) {
      expect(isPublicHostname(hostname)).toBe(true);
    }
  });

  test("never lets the controlled tab reach stella itself", () => {
    expect(parseControllableUrl("https://my.stll.app/chat")).toBeNull();
    expect(parseControllableUrl("https://app.stll.app:8443/")).toBeNull();
    expect(parseControllableUrl("https://staging.stll.app/")).toBeNull();
    expect(parseControllableUrl("https://docs.stll.app/")?.hostname).toBe(
      "docs.stll.app",
    );
  });

  test("reads a frame only when its document origin passes", () => {
    const publicFrame = {
      origin: "https://example.com",
      url: "https://example.com/embed",
    };
    expect(isControllableFrame({ isTopFrame: true, ...publicFrame })).toBe(
      true,
    );
    expect(
      isControllableFrame({
        isTopFrame: false,
        origin: "https://example.com",
        url: "about:srcdoc",
      }),
    ).toBe(true);
    expect(
      isControllableFrame({
        isTopFrame: true,
        origin: "https://example.com",
        url: "about:blank",
      }),
    ).toBe(false);
    for (const origin of ["null", "https://10.0.0.1", "http://example.com"]) {
      expect(
        isControllableFrame({ isTopFrame: false, origin, url: "about:blank" }),
      ).toBe(false);
    }
  });
});

describe("network rule host patterns", () => {
  // Chrome evaluates the patterns with RE2; they use only syntax RE2 and
  // JavaScript read the same way, so this checks the rules the tab gets.
  const patterns = NON_PUBLIC_SECURE_URL_PATTERNS.map(
    (pattern) => new RegExp(pattern, "iu"),
  );
  const nonPublicUrl = {
    test: (url: string) => patterns.some((pattern) => pattern.test(url)),
  };

  test("blocks every host the origin policy refuses", () => {
    for (const hostname of REFUSED_HOSTNAMES) {
      for (const suffix of ["/", ":8443/x", "?q=1", "#top", ""]) {
        expect(nonPublicUrl.test(`https://${hostname}${suffix}`)).toBe(true);
      }
      expect(nonPublicUrl.test(`https://user:pw@${hostname}/`)).toBe(true);
      expect(nonPublicUrl.test(`wss://${hostname}/socket`)).toBe(true);
    }
  });

  test("lets every public host through", () => {
    for (const hostname of PUBLIC_HOSTNAMES) {
      for (const suffix of ["/", ":8443/x", "?q=1", "#top", ""]) {
        expect(nonPublicUrl.test(`https://${hostname}${suffix}`)).toBe(false);
      }
      expect(nonPublicUrl.test(`wss://${hostname}/socket`)).toBe(false);
    }
    expect(nonPublicUrl.test("https://example.com/localhost")).toBe(false);
    expect(
      nonPublicUrl.test("https://example.com/?next=https://10.0.0.1/"),
    ).toBe(false);
  });
});

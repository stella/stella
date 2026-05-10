import { describe, expect, test } from "bun:test";

import {
  isTrustedProxy,
  parseTrustedProxies,
  resolveClientIp,
} from "@/api/lib/client-ip";

const fakeServer = (peer: string | null) => ({
  requestIP: () => (peer === null ? null : { address: peer }),
});

describe("parseTrustedProxies", () => {
  test("returns an empty block list for an unset value", () => {
    const trusted = parseTrustedProxies(undefined);
    expect(isTrustedProxy("1.2.3.4", trusted)).toBe(false);
    expect(isTrustedProxy("::1", trusted)).toBe(false);
  });

  test("accepts comma-separated IPv4 CIDRs", () => {
    const trusted = parseTrustedProxies("10.0.0.0/8, 192.168.0.0/16");
    expect(isTrustedProxy("10.5.5.5", trusted)).toBe(true);
    expect(isTrustedProxy("192.168.1.1", trusted)).toBe(true);
    expect(isTrustedProxy("172.16.0.1", trusted)).toBe(false);
  });

  test("treats a bare IPv4 address as a /32", () => {
    const trusted = parseTrustedProxies("203.0.113.7");
    expect(isTrustedProxy("203.0.113.7", trusted)).toBe(true);
    expect(isTrustedProxy("203.0.113.8", trusted)).toBe(false);
  });

  test("accepts IPv6 CIDRs and bare addresses", () => {
    const trusted = parseTrustedProxies("2001:db8::/32, ::1");
    expect(isTrustedProxy("2001:db8:abcd::1", trusted)).toBe(true);
    expect(isTrustedProxy("::1", trusted)).toBe(true);
    expect(isTrustedProxy("fe80::1", trusted)).toBe(false);
  });

  test("skips malformed entries without crashing", () => {
    const trusted = parseTrustedProxies(
      "not-an-ip, 10.0.0.0/8, /24, 1.2.3.4/, 192.168.0.0 / 16",
    );
    expect(isTrustedProxy("10.1.2.3", trusted)).toBe(true);
    expect(isTrustedProxy("192.168.1.1", trusted)).toBe(true);
    expect(isTrustedProxy("0.0.0.0", trusted)).toBe(false);
    expect(isTrustedProxy("8.8.8.8", trusted)).toBe(false);
  });

  test("matches IPv4-mapped IPv6 peers against IPv4 CIDRs", () => {
    // Dual-stack sockets report IPv4 clients as `::ffff:1.2.3.4`;
    // operators write proxy CIDRs as plain IPv4.
    const trusted = parseTrustedProxies("203.0.113.0/24");
    expect(isTrustedProxy("::ffff:203.0.113.7", trusted)).toBe(true);
    expect(isTrustedProxy("::ffff:203.0.113.255", trusted)).toBe(true);
    expect(isTrustedProxy("::ffff:8.8.8.8", trusted)).toBe(false);
  });
});

describe("resolveClientIp", () => {
  const request = (headers: Record<string, string> = {}) =>
    new Request("https://example/test", { headers });

  test("returns null when the runtime exposes no socket peer", () => {
    expect(
      resolveClientIp(request(), fakeServer(null), {
        trusted: parseTrustedProxies("10.0.0.0/8"),
      }),
    ).toBeNull();
  });

  test("returns the socket peer when no proxy is trusted", () => {
    const trusted = parseTrustedProxies(undefined);
    expect(
      resolveClientIp(
        request({ "cf-connecting-ip": "8.8.8.8" }),
        fakeServer("203.0.113.7"),
        { trusted },
      ),
    ).toBe("203.0.113.7");
  });

  test("ignores forwarded headers when peer is outside the trusted set", () => {
    const trusted = parseTrustedProxies("10.0.0.0/8");
    expect(
      resolveClientIp(
        request({
          "cf-connecting-ip": "8.8.8.8",
          "x-real-ip": "9.9.9.9",
          "x-forwarded-for": "10.10.10.10",
        }),
        fakeServer("203.0.113.7"),
        { trusted },
      ),
    ).toBe("203.0.113.7");
  });

  test("trusts cf-connecting-ip when peer is inside the trusted set", () => {
    const trusted = parseTrustedProxies("10.0.0.0/8");
    expect(
      resolveClientIp(
        request({
          "cf-connecting-ip": "8.8.8.8",
          "x-real-ip": "9.9.9.9",
          "x-forwarded-for": "10.10.10.10",
        }),
        fakeServer("10.1.2.3"),
        { trusted },
      ),
    ).toBe("8.8.8.8");
  });

  test("falls back to x-real-ip then the first untrusted x-forwarded-for hop", () => {
    const trusted = parseTrustedProxies("10.0.0.0/8");
    expect(
      resolveClientIp(
        request({ "x-real-ip": "9.9.9.9" }),
        fakeServer("10.1.2.3"),
        { trusted },
      ),
    ).toBe("9.9.9.9");
    expect(
      resolveClientIp(
        request({ "x-forwarded-for": "9.9.9.9, 198.51.100.23" }),
        fakeServer("10.1.2.3"),
        { trusted },
      ),
    ).toBe("198.51.100.23");
  });

  test("walks x-forwarded-for backwards through trusted proxies", () => {
    const trusted = parseTrustedProxies("10.0.0.0/8, 192.168.0.0/16");
    expect(
      resolveClientIp(
        request({
          "x-forwarded-for": "203.0.113.9, 192.168.1.20, 10.2.3.4",
        }),
        fakeServer("10.1.2.3"),
        { trusted },
      ),
    ).toBe("203.0.113.9");
  });

  test("ignores malformed forwarded header values", () => {
    const trusted = parseTrustedProxies("10.0.0.0/8");
    expect(
      resolveClientIp(
        request({ "cf-connecting-ip": "not-an-ip", "x-real-ip": "also-bad" }),
        fakeServer("10.1.2.3"),
        { trusted },
      ),
    ).toBe("10.1.2.3");
    expect(
      resolveClientIp(
        request({ "x-forwarded-for": "203.0.113.9, not-an-ip" }),
        fakeServer("10.1.2.3"),
        { trusted },
      ),
    ).toBe("10.1.2.3");
  });

  test("returns the trusted-proxy peer when all forwarded headers are missing", () => {
    const trusted = parseTrustedProxies("10.0.0.0/8");
    expect(
      resolveClientIp(request(), fakeServer("10.1.2.3"), { trusted }),
    ).toBe("10.1.2.3");
  });
});
